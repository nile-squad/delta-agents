/**
 * Skill content loading.
 *
 * A Skill carries a `path` to its content. The library does not assume a
 * filesystem, so the consumer supplies a `loadSkill` loader; when configured, the
 * content of each active skill is loaded and surfaced to the reasoner alongside
 * the skill's name and description. A load failure is non-fatal. Without a loader,
 * skills are still surfaced by name and description (content omitted).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import type { ReasonerPort } from "../../src/ports/reasoner-port";
import type { Skill } from "../../src/authoring/types";

type CapturedSkills = Array<{ name: string; description: string; content?: string }> | undefined;

const refundSkill: Skill = {
  name: "refund-policy",
  description: "the refund policy",
  path: "/skills/refund.md",
  active: true,
};

/** A reasoner that records the skills it was offered, then finishes. */
const capturingReasoner = (sink: CapturedSkills[]): ReasonerPort => ({
  reason: async ({ availableSkills }) => {
    sink.push(availableSkills);
    return Ok({ kind: "done" });
  },
});

const deploy = async (delta: Awaited<ReturnType<typeof createDeltaEngine>>, skills: Skill[]) => {
  const act = delta.action({ name: "act", description: "work", schema: z.object({}), fn: async () => Ok("ok") });
  delta.deploy(delta.agent({ name: "agent", description: "d", role: "R", rolePrompt: ".", actions: [act], skills }));
};

describe("skill content loading", () => {
  it("loads and surfaces active skill content when a loader is configured", async () => {
    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({
      reasoner: capturingReasoner(captured),
      loadSkill: async (skill) => Ok(`CONTENT for ${skill.name}`),
    });
    await deploy(delta, [refundSkill]);

    const result = await delta.send({ goal: "go", agentName: "agent" });
    expect(result.isOk).toBe(true);
    const skill = captured[0]?.[0];
    expect(skill?.name).toBe("refund-policy");
    expect(skill?.content).toBe("CONTENT for refund-policy");
  });

  it("surfaces skills by name and description without a loader (content omitted)", async () => {
    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({ reasoner: capturingReasoner(captured) });
    await deploy(delta, [refundSkill]);

    await delta.send({ goal: "go", agentName: "agent" });
    const skill = captured[0]?.[0];
    expect(skill?.name).toBe("refund-policy");
    expect(skill?.content).toBeUndefined();
  });

  it("treats a load failure as non-fatal: the skill is still offered without content", async () => {
    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({
      reasoner: capturingReasoner(captured),
      loadSkill: async () => Err("file not found"),
    });
    await deploy(delta, [refundSkill]);

    const result = await delta.send({ goal: "go", agentName: "agent" });
    expect(result.isOk).toBe(true);
    const skill = captured[0]?.[0];
    expect(skill?.name).toBe("refund-policy");
    expect(skill?.content).toBeUndefined();
  });

  it("omits inactive skills", async () => {
    const captured: CapturedSkills[] = [];
    const delta = await createDeltaEngine({
      reasoner: capturingReasoner(captured),
      loadSkill: async (skill) => Ok(`CONTENT for ${skill.name}`),
    });
    await deploy(delta, [refundSkill, { name: "draft", description: "wip", path: "/x.md", active: false }]);

    await delta.send({ goal: "go", agentName: "agent" });
    expect(captured[0]?.map((s) => s.name)).toEqual(["refund-policy"]);
  });
});
