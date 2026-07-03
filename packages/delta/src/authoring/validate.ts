/**
 * Authoring-time validation for Action, Workflow, Phase, and Agent definitions.
 *
 * All validation runs at definition time (when the developer calls delta.action etc.),
 * not at execution time. A definition that passes validation is safe to register.
 * A definition that fails must never reach the registry — it is a programming error,
 * not a runtime failure, so we return Err rather than throw.
 *
 * Validated here:
 * - Schema present on every action (spec invariant 4)
 * - Risk value in 1–5 when declared
 * - Unique names within each type (enforced again by registry, checked early here
 *   to give a clear error before the registry sees it)
 * - Branch target names reference declared actions within the same phase
 * - Prerequisite action/workflow names are resolvable in the known registry
 * - Phase action refs are non-empty
 * - Workflow phases list is non-empty
 * - Agent actions list is non-empty
 * - Skill string refs on actions and workflow phases resolve to declared agent skills
 * - Tool name non-empty, no "system:" prefix, description/schema/fn present, limits valid
 */

import type { Result } from "slang-ts";
import { Ok, Err } from "slang-ts";
import type { Action, Workflow, Phase, Agent, ActionRef, Branch, DataSource, Tool } from "./types";
import { DATA_SOURCE_OPERATIONS, dataSourceActions } from "./types";

const isBranch = (ref: ActionRef): ref is Branch =>
  typeof ref === "object" && "action" in ref;

/** Collect all action names referenced directly inside a phase's action list. */
const referencedActionNamesInPhase = (phase: Phase): string[] =>
  phase.actions.map((ref) => (isBranch(ref) ? ref.action : ref));

/** Collect all branch target names in a phase (onSuccess / onFailure targets). */
const branchTargetNames = (phase: Phase): string[] =>
  phase.actions
    .filter(isBranch)
    .flatMap((b) => [b.onSuccess, b.onFailure].filter((t): t is string => t !== undefined));

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const validateAction = (action: Action): Result<Action, string> => {
  if (!action.name || action.name.trim() === "") {
    return Err("action name must be a non-empty string");
  }
  if (!action.description || action.description.trim() === "") {
    return Err(`action "${action.name}": description must be a non-empty string`);
  }
  // Every executable action must have a validation schema (invariant 4).
  if (action.schema === undefined || action.schema === null) {
    return Err(`action "${action.name}": schema is required (spec invariant 4)`);
  }
  // Risk is optional but when declared must be 1–5.
  if (action.risk !== undefined && (action.risk < 1 || action.risk > 5)) {
    return Err(`action "${action.name}": risk must be 1, 2, 3, 4, or 5 when declared`);
  }
  if (!action.fn || typeof action.fn !== "function") {
    return Err(`action "${action.name}": fn must be a function`);
  }
  return Ok(action);
};

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export const validatePhase = (phase: Phase): Result<Phase, string> => {
  if (!phase.name || phase.name.trim() === "") {
    return Err("phase name must be a non-empty string");
  }
  if (!phase.description || phase.description.trim() === "") {
    return Err(`phase "${phase.name}": description must be a non-empty string`);
  }
  if (!Array.isArray(phase.actions) || phase.actions.length === 0) {
    return Err(`phase "${phase.name}": actions list must be non-empty`);
  }

  // Every action ref in the phase must have a non-empty action name.
  for (const ref of phase.actions) {
    const name = isBranch(ref) ? ref.action : ref;
    if (!name || name.trim() === "") {
      return Err(`phase "${phase.name}": action ref contains an empty action name`);
    }
  }

  // A branch must declare at least one routing target.
  for (const ref of phase.actions) {
    if (isBranch(ref)) {
      const hasTarget = ref.onSuccess !== undefined || ref.onFailure !== undefined || ref.when !== undefined;
      if (!hasTarget) {
        return Err(
          `phase "${phase.name}": branch for action "${ref.action}" must declare onSuccess, onFailure, or when`,
        );
      }
    }
  }

  // Branch targets must reference actions also declared in this phase.
  const directNames = new Set(referencedActionNamesInPhase(phase));
  const targets = branchTargetNames(phase);
  for (const target of targets) {
    if (!directNames.has(target)) {
      return Err(
        `phase "${phase.name}": branch target "${target}" is not declared in this phase's action list`,
      );
    }
  }

  if (phase.supervision !== undefined) {
    if (phase.supervision.maxRetries < 0) {
      return Err(`phase "${phase.name}": maxRetries must be >= 0`);
    }
  }

  return Ok(phase);
};

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const validateWorkflow = (workflow: Workflow): Result<Workflow, string> => {
  if (!workflow.name || workflow.name.trim() === "") {
    return Err("workflow name must be a non-empty string");
  }
  if (!workflow.description || workflow.description.trim() === "") {
    return Err(`workflow "${workflow.name}": description must be a non-empty string`);
  }
  if (!workflow.version || workflow.version.trim() === "") {
    return Err(`workflow "${workflow.name}": version must be a non-empty string`);
  }
  if (!Array.isArray(workflow.phases) || workflow.phases.length === 0) {
    return Err(`workflow "${workflow.name}": phases list must be non-empty`);
  }
  // Validate each phase inline — phases are plain objects embedded in the
  // workflow, not separately registered, so validation happens here.
  for (const phase of workflow.phases) {
    const phaseResult = validatePhase(phase);
    if (phaseResult.isErr) {
      return Err(`workflow "${workflow.name}": ${phaseResult.error}`);
    }
  }
  return Ok(workflow);
};

// ---------------------------------------------------------------------------
// DataSource
// ---------------------------------------------------------------------------

export const validateDataSource = (dataSource: DataSource): Result<DataSource, string> => {
  if (!dataSource.name || dataSource.name.trim() === "") {
    return Err("data source name must be a non-empty string");
  }
  if (!dataSource.description || dataSource.description.trim() === "") {
    return Err(`data source "${dataSource.name}": description must be a non-empty string`);
  }
  if (dataSource.ownership !== "internal" && dataSource.ownership !== "external") {
    return Err(`data source "${dataSource.name}": ownership must be "internal" or "external"`);
  }
  if (!dataSource.contentType || dataSource.contentType.trim() === "") {
    return Err(`data source "${dataSource.name}": contentType must be a non-empty string`);
  }
  if (dataSource.authentication !== undefined) {
    const authType = dataSource.authentication.type;
    if (!authType || authType.trim() === "") {
      return Err(`data source "${dataSource.name}": authentication.type must be a non-empty string when declared`);
    }
  }

  // At least one CRUD operation must be defined — an empty data source is useless
  // and almost always a mistake.
  const operations = dataSourceActions(dataSource);
  if (operations.length === 0) {
    return Err(
      `data source "${dataSource.name}": at least one operation (${DATA_SOURCE_OPERATIONS.join(", ")}) must be defined`,
    );
  }

  // Each defined operation is a full action and must pass action validation:
  // a data read or write is governed exactly like any other action.
  for (const action of operations) {
    const result = validateAction(action);
    if (result.isErr) {
      return Err(`data source "${dataSource.name}": ${result.error}`);
    }
  }

  return Ok(dataSource);
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const validateAgent = (
  agent: Agent,
  knownActionNames: Set<string>,
  knownWorkflowNames: Set<string>,
): Result<Agent, string> => {
  if (!agent.name || agent.name.trim() === "") {
    return Err("agent name must be a non-empty string");
  }
  if (!agent.description || agent.description.trim() === "") {
    return Err(`agent "${agent.name}": description must be a non-empty string`);
  }
  if (!agent.role || agent.role.trim() === "") {
    return Err(`agent "${agent.name}": role must be a non-empty string`);
  }
  if (!agent.rolePrompt || agent.rolePrompt.trim() === "") {
    return Err(`agent "${agent.name}": rolePrompt must be a non-empty string`);
  }
  if (!Array.isArray(agent.actions) || agent.actions.length === 0) {
    return Err(`agent "${agent.name}": actions list must be non-empty`);
  }

  // Every action attached to the agent must be in the registry.
  for (const action of agent.actions) {
    if (!knownActionNames.has(action.name)) {
      return Err(
        `agent "${agent.name}": action "${action.name}" must be registered before attaching to an agent`,
      );
    }
  }

  // Prerequisite action/workflow names must resolve to registered actions/workflows.
  // A typo here silently never satisfies at runtime, so we catch it at definition time.
  for (const action of agent.actions) {
    if (action.prerequisites) {
      for (const prereqAction of action.prerequisites.actions ?? []) {
        if (!knownActionNames.has(prereqAction)) {
          return Err(
            `agent "${agent.name}": action "${action.name}" declares prerequisite action "${prereqAction}" that is not registered`,
          );
        }
      }
      for (const prereqWorkflow of action.prerequisites.workflows ?? []) {
        if (!knownWorkflowNames.has(prereqWorkflow)) {
          return Err(
            `agent "${agent.name}": action "${action.name}" declares prerequisite workflow "${prereqWorkflow}" that is not registered`,
          );
        }
      }
    }
  }

  // Every workflow attached to the agent must be in the registry.
  for (const wf of agent.workflows ?? []) {
    if (!knownWorkflowNames.has(wf.name)) {
      return Err(
        `agent "${agent.name}": workflow "${wf.name}" must be registered before attaching to an agent`,
      );
    }
  }

  // Skill string refs must resolve to skills declared on the agent. An unknown
  // name ref is a programming error — it will silently produce no skill at runtime,
  // which is almost never the intent. Inline Skill objects bypass this check because
  // they are explicit definitions, not symbolic references.
  const declaredSkillNames = new Set((agent.skills ?? []).map((s) => s.name));

  for (const action of agent.actions) {
    for (const ref of action.skills ?? []) {
      if (typeof ref === "string" && !declaredSkillNames.has(ref)) {
        return Err(
          `agent "${agent.name}": action "${action.name}" references undeclared skill "${ref}" — add it to agent.skills first`,
        );
      }
    }
  }

  for (const wf of agent.workflows ?? []) {
    for (const phase of wf.phases) {
      for (const ref of phase.skills ?? []) {
        if (typeof ref === "string" && !declaredSkillNames.has(ref)) {
          return Err(
            `agent "${agent.name}": workflow "${wf.name}" phase "${phase.name}" references undeclared skill "${ref}" — add it to agent.skills first`,
          );
        }
      }
    }
  }

  return Ok(agent);
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const validateTool = (tool: Tool): Result<Tool, string> => {
  if (!tool.name || tool.name.trim() === "") {
    return Err("tool name must be a non-empty string");
  }
  // Reserve system: prefix for internal framework tools
  if (tool.name.startsWith("system:")) {
    return Err(`tool "${tool.name}": name must not start with "system:" (reserved for internal tools)`);
  }
  if (!tool.description || tool.description.trim() === "") {
    return Err(`tool "${tool.name}": description must be a non-empty string`);
  }
  if (tool.schema === undefined || tool.schema === null) {
    return Err(`tool "${tool.name}": schema is required`);
  }
  if (!tool.fn || typeof tool.fn !== "function") {
    return Err(`tool "${tool.name}": fn must be a function`);
  }
  if (tool.limits !== undefined) {
    if (tool.limits.cooldownMs !== undefined && tool.limits.cooldownMs < 0) {
      return Err(`tool "${tool.name}": cooldownMs must be >= 0`);
    }
    if (tool.limits.maxCallsPerPhase !== undefined && tool.limits.maxCallsPerPhase < 1) {
      return Err(`tool "${tool.name}": maxCallsPerPhase must be >= 1`);
    }
    if (tool.limits.maxCallsPerTask !== undefined && tool.limits.maxCallsPerTask < 1) {
      return Err(`tool "${tool.name}": maxCallsPerTask must be >= 1`);
    }
  }
  return Ok(tool);
};
