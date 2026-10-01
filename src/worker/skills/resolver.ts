import type { SkillContext } from "../../shared/contracts";
import { CapabilityRegistry } from "../capabilities/registry";
import type { ExecutableSkill } from "./schemas";

export type InstalledSkill = ExecutableSkill;
export type SkillResolution =
  | { kind: "selected"; source: "explicit" | "automatic"; skill: SkillContext }
  | { kind: "ambiguous"; skillIds: string[] }
  | { kind: "none" };

export class SkillResolver {
  private skills: InstalledSkill[] = [];
  constructor(
    private capabilities: CapabilityRegistry,
    skills: InstalledSkill[] = [],
  ) {
    for (const skill of skills) this.install(skill);
  }
  install(skill: InstalledSkill) {
    this.capabilities.requests(skill.tools); // installation-time allowlist validation
    const version = skill.commitSha;
    if (
      this.skills.some(
        (item) => item.id === skill.id && item.commitSha === version,
      )
    )
      throw new Error("SKILL_ALREADY_INSTALLED");
    this.skills.push(structuredClone(skill));
  }
  resolve(text: string, userId: string, explicitId?: string): SkillResolution {
    const command = text.match(/^\/skill\s+([a-z0-9_.-]+)(?:\s|$)/i)?.[1];
    const selectedId = explicitId ?? command;
    if (selectedId) {
      const skill = this.skills.find(
        (item) => item.id === selectedId && this.available(item, userId),
      );
      if (!skill) return { kind: "none" };
      return {
        kind: "selected",
        source: "explicit",
        skill: this.context(skill),
      };
    }
    const normalized = text.toLowerCase();
    const candidates = this.skills
      .filter((skill) => this.available(skill, userId))
      .map((skill) => {
        const phrases = skill.triggers.phrases ?? [];
        const keywords = skill.triggers.keywords ?? [];
        const phrase = phrases.some((item) =>
          normalized.includes(item.toLowerCase()),
        );
        const hits = keywords.filter((item) =>
          new RegExp(`\\b${escape(item.toLowerCase())}\\b`, "i").test(
            normalized,
          ),
        ).length;
        const confidence = phrase
          ? 1
          : keywords.length
            ? hits / keywords.length
            : 0;
        return { skill, confidence };
      })
      .filter(
        ({ skill, confidence }) =>
          confidence >= skill.triggers.minimumConfidence,
      )
      .sort((a, b) => b.confidence - a.confidence);
    if (!candidates.length) return { kind: "none" };
    if (
      candidates[1] &&
      candidates[0]!.confidence - candidates[1].confidence < 0.15
    )
      return {
        kind: "ambiguous",
        skillIds: candidates
          .filter((item) => candidates[0]!.confidence - item.confidence < 0.15)
          .map((item) => item.skill.id),
      };
    return {
      kind: "selected",
      source: "automatic",
      skill: this.context(candidates[0]!.skill),
    };
  }
  private context(skill: InstalledSkill): SkillContext {
    // Re-check the allowlist at execution time; a stale/uninstalled capability cannot run.
    return {
      id: skill.id,
      version: skill.commitSha,
      instructions: skill.instructions,
      capabilities: this.capabilities.requests(skill.tools),
      prohibitedActions: skill.prohibitedActions ?? [],
    };
  }
  private available(skill: InstalledSkill, userId: string): boolean {
    return (
      skill.status === "active" &&
      (skill.visibility === "public" ||
        skill.ownerTelegramUserIds.includes(userId) ||
        (skill.visibility === "shared" &&
          skill.allowedTelegramUserIds.includes(userId)))
    );
  }
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
