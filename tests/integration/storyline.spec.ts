/**
 * Storyline plumbing — workflow and phase narrative reaches ActionContext.
 *
 * Storyline is the developer's free-prose description of the ideal user
 * experience for a workflow and each of its phases. The story reaches the
 * agent through exactly one channel: ActionContext. The reasoner prompt and
 * any other surface stay untouched.
 *
 * Free loop (no workflow) has no storyline source, so the fields stay
 * `undefined` in every ActionContext the scheduler builds.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createMockReasoner } from "../../src/ports/mock-reasoner";

type Captured = { storyline?: string; phaseStoryline?: string };

describe("storyline plumbing (workflow + phase narrative reaches ActionContext)", () => {
  it("threaded through gateway: workflow and phase storylines reach action fn on ctx", async () => {
    const capturedCtx: Captured[] = [];
    // No reasoner responses scripted — a workflow task must not consult the reasoner.
    const delta = await createDeltaEngine({ reasoner: createMockReasoner({ responses: [] }) });

    const act = delta.action({
      name: "greet",
      description: "captures the ctx storylines",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        capturedCtx.push({ storyline: ctx.storyline, phaseStoryline: ctx.phaseStoryline });
        return Ok("ok");
      },
    });

    const wf = delta.workflow({
      name: "support",
      description: "support flow",
      version: "1",
      phases: [
        {
          name: "greet-phase",
          description: "first touch",
          actions: ["greet"],
          checkpoint: false,
          storyline: "Greet the user warmly and ask one clarifying question",
        },
      ],
      storyline: "User contacts support, agent greets warmly, resolves issue, confirms satisfaction",
    });

    delta.deploy(delta.agent({
      name: "support-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [act],
      workflows: [wf],
    }));

    const result = await delta.send({ goal: "help", agentName: "support-agent", workflow: "support" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(capturedCtx[0]?.storyline).toBe(
      "User contacts support, agent greets warmly, resolves issue, confirms satisfaction",
    );
    expect(capturedCtx[0]?.phaseStoryline).toBe(
      "Greet the user warmly and ask one clarifying question",
    );
  });

  it("free loop (no workflow) leaves both storyline fields undefined on ctx", async () => {
    const capturedCtx: Captured[] = [];
    const delta = await createDeltaEngine({
      reasoner: createMockReasoner({ responses: [{ actionName: "act", input: {} }] }),
    });

    const act = delta.action({
      name: "act",
      description: "captures ctx storylines",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        capturedCtx.push({ storyline: ctx.storyline, phaseStoryline: ctx.phaseStoryline });
        return Ok("ok");
      },
    });

    delta.deploy(delta.agent({
      name: "free-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [act],
    }));

    const result = await delta.send({ goal: "go", agentName: "free-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(capturedCtx[0]?.storyline).toBeUndefined();
    expect(capturedCtx[0]?.phaseStoryline).toBeUndefined();
  });

  it("phase before hook receives both workflow and phase storylines", async () => {
    const capturedHook: Captured[] = [];
    // No reasoner responses scripted — a workflow task must not consult the reasoner.
    const delta = await createDeltaEngine({ reasoner: createMockReasoner({ responses: [] }) });

    const act = delta.action({
      name: "work",
      description: "trivial action so the phase has something to do",
      schema: z.object({}),
      fn: async () => Ok("ok"),
    });

    const wf = delta.workflow({
      name: "hooked",
      description: "hook visibility test",
      version: "1",
      phases: [
        {
          name: "first",
          description: "first phase",
          actions: ["work"],
          checkpoint: false,
          storyline: "Beat 1: open the conversation",
          hooks: {
            before: async (ctx) => {
              capturedHook.push({ storyline: ctx.storyline, phaseStoryline: ctx.phaseStoryline });
              return Ok("ok");
            },
          },
        },
      ],
      storyline: "Arc: user arrives, agent guides, task done",
    });

    delta.deploy(delta.agent({
      name: "hooked-agent",
      description: "d",
      role: "r",
      rolePrompt: ".",
      actions: [act],
      workflows: [wf],
    }));

    const result = await delta.send({ goal: "go", agentName: "hooked-agent", workflow: "hooked" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(capturedHook[0]?.storyline).toBe("Arc: user arrives, agent guides, task done");
    expect(capturedHook[0]?.phaseStoryline).toBe("Beat 1: open the conversation");
  });
});
