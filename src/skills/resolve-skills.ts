import { readFile } from "node:fs/promises";
import type { Skill } from "../authoring/types";

export type AvailableSkill = { name: string; description: string; content?: string };

const loadSkillContent = async (folder: string): Promise<string | undefined> => {
  try {
    return await readFile(`${folder}/SKILL.md`, "utf-8");
  } catch {
    return undefined;
  }
};

/**
 * Resolve skill references (strings = name, Skill objects pass through) against
 * the agent's declared skill set. Unknown name refs are silently skipped.
 */
export const resolveSkillRefs = (
  refs: (string | Skill)[],
  agentSkills: Skill[],
): Skill[] => {
  const byName = new Map(agentSkills.map((s) => [s.name, s]));
  const result: Skill[] = [];
  for (const ref of refs) {
    if (typeof ref === "string") {
      const found = byName.get(ref);
      if (found !== undefined) result.push(found);
    } else {
      result.push(ref);
    }
  }
  return result;
};

/**
 * Build the list of available skills for the reasoner / ActionContext.
 *
 * Reads each skill's SKILL.md from its folder. Skills without a SKILL.md are
 * skipped entirely — the convention requires it for a skill to be usable.
 */
export const buildAvailableSkills = async (skills: Skill[]): Promise<AvailableSkill[]> => {
  const result: AvailableSkill[] = [];
  for (const skill of skills) {
    const content = await loadSkillContent(skill.folder);
    if (content === undefined) continue;
    result.push({ name: skill.name, description: skill.description, content });
  }
  return result;
};
