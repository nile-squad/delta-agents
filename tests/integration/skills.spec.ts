/**
 * Skill loading via SKILL.md convention.
 *
 * Each skill declares a folder. The engine reads SKILL.md from that folder to
 * get the skill content. Skills without a SKILL.md are silently omitted from
 * the reasoner's available-skills list (non-fatal). Skills are scoped to where
 * they're mentioned: agent-level → all steps; phase-level → that phase;
 * action-level → that action only.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import type { ReasonerPort } from "../../src/ports/reasoner-port";
import type { Skill } from "../../src/authoring/types";

type CapturedSkills = Array<{ name: string; description: string; content?: string }> | undefined;

/** A reasoner that records the skills it was offered, then finishes. */
const capturingReasoner = (sink: CapturedSkills[]): ReasonerPort => ({
  reason: async ({ availableSkills }) => {
    sink.push(availableSkills);
    return Ok({ kind: "done" });
  },
});

/** Create a temp skill folder with a SKILL.md containing `content`. */
const makeSkillFolder = (base: string, name: string, content: string): string => {
  const folder = join(base, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), content, "utf-8");
  return folder;
};

const deploy = async (
  delta: Awaited<ReturnType<typeof createDeltaEngine>>,
  skills: Skill[],
) => {
  const act = delta.action({ name: "act", description: "work", schema: z.object({}), fn: async () => Ok("ok") });
  delta.deploy(delta.agent({ name: "agent", description: "d", role: "R", rolePrompt: ".", actions: [act], skills }));
};

describe("skill content loading (SKILL.md convention)", () => {
  const temps: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-skills-"));
    temps.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps.length = 0;
  });

  it("surfaces skill content from SKILL.md to the reasoner", async () => {
    const base = tmp();
    const folder = makeSkillFolder(base, "refunds", "# Refund Policy\nAll sales final.");
    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({ reasoner: capturingReasoner(captured) });
    await deploy(delta, [{ name: "refund-policy", description: "the refund policy", folder }]);

    const result = await delta.send({ goal: "go", agentName: "agent" });
    expect(result.isOk).toBe(true);
    const skill = captured[0]?.[0];
    expect(skill?.name).toBe("refund-policy");
    expect(skill?.description).toBe("the refund policy");
    expect(skill?.content).toBe("# Refund Policy\nAll sales final.");
  });

  it("omits skills whose folder has no SKILL.md", async () => {
    const base = tmp();
    mkdirSync(join(base, "no-file"), { recursive: true }); // folder exists, no SKILL.md
    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({ reasoner: capturingReasoner(captured) });
    await deploy(delta, [{ name: "broken", description: "no skill file", folder: join(base, "no-file") }]);

    await delta.send({ goal: "go", agentName: "agent" });
    expect(captured[0]).toEqual([]);
  });

  it("surfaces multiple skills; omits those without SKILL.md", async () => {
    const base = tmp();
    const f1 = makeSkillFolder(base, "s1", "Skill one content");
    const f2 = join(base, "s2"); // no SKILL.md
    mkdirSync(f2, { recursive: true });
    const f3 = makeSkillFolder(base, "s3", "Skill three content");

    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({ reasoner: capturingReasoner(captured) });
    await deploy(delta, [
      { name: "s1", description: "first skill", folder: f1 },
      { name: "s2", description: "second skill", folder: f2 },
      { name: "s3", description: "third skill", folder: f3 },
    ]);

    await delta.send({ goal: "go", agentName: "agent" });
    const names = captured[0]?.map((s) => s.name);
    expect(names).toEqual(["s1", "s3"]);
  });
});

describe("skill scoping in workflows", () => {
  const temps: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-skills-scope-"));
    temps.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps.length = 0;
  });

  it("phase.skills scopes which skills are active in ActionContext", async () => {
    const base = tmp();
    const f1 = makeSkillFolder(base, "sk1", "Skill 1");
    const f2 = makeSkillFolder(base, "sk2", "Skill 2");

    const capturedCtx: Array<{ name: string; description: string; content?: string }[] | undefined> = [];
    const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) } });
    const act = delta.action({
      name: "capture",
      description: "captures ctx skills",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        capturedCtx.push(ctx.availableSkills);
        return Ok("ok");
      },
    });

    const wf = delta.workflow({
      name: "wf",
      description: "wf",
      version: "1",
      phases: [
        {
          name: "phase1",
          description: "only sk1 active",
          checkpoint: false,
          actions: ["capture"],
          // sk2 is not listed → not active for this phase
          skills: [{ name: "sk1", description: "first", folder: f1 }],
        },
      ],
    });

    const agent = delta.agent({
      name: "scoped-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [act],
      workflows: [wf],
      // Agent declares both; phase narrows to sk1 only
      skills: [
        { name: "sk1", description: "first", folder: f1 },
        { name: "sk2", description: "second", folder: f2 },
      ],
    });
    delta.deploy(agent);

    const result = await delta.send({ goal: "go", agentName: "scoped-agent", workflow: "wf" });
    expect(result.isOk).toBe(true);
    expect(capturedCtx[0]?.map((s) => s.name)).toEqual(["sk1"]);
  });

  it("action.skills overrides phase.skills for that action", async () => {
    const base = tmp();
    const fPhase = makeSkillFolder(base, "phase-sk", "Phase skill");
    const fAction = makeSkillFolder(base, "action-sk", "Action skill");

    const capturedCtx: Array<{ name: string; description: string; content?: string }[] | undefined> = [];
    const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) } });
    const act = delta.action({
      name: "capture",
      description: "captures ctx skills",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        capturedCtx.push(ctx.availableSkills);
        return Ok("ok");
      },
      // Override: only the action-level skill is active here
      skills: [{ name: "action-sk", description: "action skill", folder: fAction }],
    });

    const wf = delta.workflow({
      name: "wf",
      description: "wf",
      version: "1",
      phases: [
        {
          name: "p1",
          description: "phase with its own skill",
          checkpoint: false,
          actions: ["capture"],
          skills: [{ name: "phase-sk", description: "phase skill", folder: fPhase }],
        },
      ],
    });

    delta.deploy(delta.agent({
      name: "override-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [act],
      workflows: [wf],
    }));

    const result = await delta.send({ goal: "go", agentName: "override-agent", workflow: "wf" });
    expect(result.isOk).toBe(true);
    expect(capturedCtx[0]?.map((s) => s.name)).toEqual(["action-sk"]);
  });
});

describe("authoring-time skill ref validation", () => {
  it("throws at delta.agent() when an action's skill string ref is not declared on the agent", async () => {
    const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) } });
    const act = delta.action({
      name: "act",
      description: "work",
      schema: z.object({}),
      fn: async () => Ok("ok"),
      skills: ["unknown-skill"], // string ref — not in agent.skills
    });
    expect(() =>
      delta.agent({
        name: "bad-agent",
        description: "d",
        role: "r",
        rolePrompt: ".",
        actions: [act],
        // agent.skills is empty — the ref "unknown-skill" cannot resolve
      }),
    ).toThrow(/undeclared skill "unknown-skill"/);
  });

  it("throws at delta.agent() when a workflow phase's skill string ref is not declared on the agent", async () => {
    const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) } });
    const act = delta.action({ name: "act", description: "work", schema: z.object({}), fn: async () => Ok("ok") });
    const wf = delta.workflow({
      name: "wf",
      description: "wf",
      version: "1",
      phases: [
        {
          name: "p1",
          description: "phase",
          checkpoint: false,
          actions: ["act"],
          skills: ["ghost-skill"], // string ref — not in agent.skills
        },
      ],
    });
    expect(() =>
      delta.agent({
        name: "bad-agent",
        description: "d",
        role: "r",
        rolePrompt: ".",
        actions: [act],
        workflows: [wf],
      }),
    ).toThrow(/undeclared skill "ghost-skill"/);
  });

  it("accepts string skill refs that match declared agent.skills names", async () => {
    const base = mkdtempSync(join(tmpdir(), "delta-skills-valid-"));
    try {
      const folder = join(base, "sk");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), "skill content", "utf-8");

      const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) } });
      const act = delta.action({
        name: "act",
        description: "work",
        schema: z.object({}),
        fn: async () => Ok("ok"),
        skills: ["my-skill"], // string ref matching agent.skills entry below
      });
      expect(() =>
        delta.agent({
          name: "good-agent",
          description: "d",
          role: "r",
          rolePrompt: ".",
          actions: [act],
          skills: [{ name: "my-skill", description: "valid skill", folder }],
        }),
      ).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("accepts inline Skill objects in action.skills without requiring agent.skills declaration", async () => {
    const base = mkdtempSync(join(tmpdir(), "delta-skills-inline-"));
    try {
      const folder = join(base, "sk");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), "skill content", "utf-8");

      const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) } });
      const act = delta.action({
        name: "act",
        description: "work",
        schema: z.object({}),
        fn: async () => Ok("ok"),
        // Inline Skill object — bypasses name-ref validation
        skills: [{ name: "inline-skill", description: "inline", folder }],
      });
      expect(() =>
        delta.agent({
          name: "inline-agent",
          description: "d",
          role: "r",
          rolePrompt: ".",
          actions: [act],
          // No agent.skills needed when using inline Skill objects
        }),
      ).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
