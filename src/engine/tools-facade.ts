/**
 * delta.tools — the developer-facing tool invocation surface.
 *
 * `invoke(name, input, ctx?)` runs any registered tool (builtin or custom)
 * directly from developer code, so the same capability serves both a human
 * caller and an agent. An agent reaches a tool through the reasoner's
 * `system:use_tool` decision (handled in ./tool-dispatch, with full task-scoped
 * governance: loop detection, budget, tool-history recording). `invoke` is the
 * out-of-band path — there is no task to govern, so it validates the input
 * against the tool's schema and runs it, and deliberately does NOT record
 * history, touch the store, or apply loop/budget limits. Those are properties of
 * a governed task step, not of a standalone utility call.
 */

import { Err, option, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import { prettifyError } from "zod";
import type { Registry } from "../authoring/registry";
import type { ToolContext } from "../authoring/types";
import type { InvokeArgs } from "./types";

export type ToolsFacade = {
  /**
   * Invoke a registered tool. Returns the tool's own Result on success, or an
   * Err when the tool is unknown, the input fails the tool's schema, or the tool
   * fn throws. Named arguments (`{ tool, input, ctx? }`) keep the call shape
   * identical across every tool; `ctx` supplies whatever the tool needs (most
   * commonly `attachments`), with identity fields defaulting to placeholders.
   */
  invoke: (args: InvokeArgs) => Promise<Result<unknown, string>>;
};

export const makeToolsFacade = ({ registry }: { registry: Registry }): ToolsFacade => ({
  invoke: async ({ tool: name, input, ctx }) => {
    const toolRes = registry.getTool(name);
    if (toolRes.isErr) return Err(`tools.invoke: ${toolRes.error}`);
    const tool = toolRes.value;

    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      return Err(`tools.invoke: input for tool "${name}" is invalid — ${prettifyError(parsed.error)}`);
    }

    const attachmentsOpt = option(ctx?.attachments);
    const phaseNameOpt = option(ctx?.phaseName);
    const toolContext: ToolContext = {
      agentName: ctx?.agentName ?? "system:invoke",
      taskId: ctx?.taskId ?? "none",
      toolHistory: ctx?.toolHistory ?? [],
      ...(phaseNameOpt.isSome ? { phaseName: phaseNameOpt.value } : {}),
      ...(attachmentsOpt.isSome ? { attachments: attachmentsOpt.value } : {}),
    };

    // safeTry flattens a returned Result: a tool that returns Err surfaces that
    // Err unchanged, a tool that throws surfaces the thrown message as Err, and a
    // tool that returns Ok(v) surfaces Ok(v). So the tool's own Result is exactly
    // what we return — same normalization tool-dispatch relies on.
    return safeTry(async () => tool.fn({ data: parsed.data, ctx: toolContext }));
  },
});
