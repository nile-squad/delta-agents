import { describe, it, expect } from "vitest";
import { resolveSkillRefs } from "../../../src/skills/resolve-skills";
import type { Skill } from "../../../src/authoring/types";

const skill = (name: string): Skill => ({ name, description: `desc-${name}`, folder: `/skills/${name}` });

describe("resolveSkillRefs", () => {
  it("resolves string refs to their Skill objects", () => {
    const agentSkills = [skill("a"), skill("b")];
    const result = resolveSkillRefs(["a", "b"], agentSkills);
    expect(result.isOk).toBe(true);
    expect(result.isOk && result.value.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("passes inline Skill objects through unchanged", () => {
    const inline: Skill = { name: "x", description: "d", folder: "/x" };
    const result = resolveSkillRefs([inline], []);
    expect(result.isOk).toBe(true);
    expect(result.isOk && result.value[0]).toBe(inline);
  });

  it("mixes string refs and inline Skill objects", () => {
    const agentSkills = [skill("a")];
    const inline: Skill = { name: "b", description: "db", folder: "/b" };
    const result = resolveSkillRefs(["a", inline], agentSkills);
    expect(result.isOk).toBe(true);
    expect(result.isOk && result.value.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("returns Err for an unknown string ref", () => {
    const result = resolveSkillRefs(["ghost"], [skill("real")]);
    expect(result.isErr).toBe(true);
    expect(result.isErr && result.error).toMatch(/"ghost"/);
  });

  it("returns Err on the first unknown ref even when earlier refs are valid", () => {
    const result = resolveSkillRefs(["real", "ghost"], [skill("real")]);
    expect(result.isErr).toBe(true);
    expect(result.isErr && result.error).toMatch(/"ghost"/);
  });

  it("returns Ok([]) for an empty refs list", () => {
    const result = resolveSkillRefs([], [skill("a")]);
    expect(result.isOk).toBe(true);
    expect(result.isOk && result.value).toEqual([]);
  });
});
