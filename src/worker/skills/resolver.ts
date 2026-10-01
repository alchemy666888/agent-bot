import type {
  AuthorizedSkillDescriptor,
  SkillContext,
} from "../../shared/contracts";
import { CapabilityRegistry } from "../capabilities/registry";
import type { InstalledSkill as CommandSkill } from "../commands";
import type { ExecutableSkill } from "./schemas";

export type InstalledSkill = ExecutableSkill;
/** Kept in sync with routingRequestSchema's bounded classifier payload. */
export const MAX_ROUTING_SKILLS = 200;
export type SkillResolution =
  | { kind: "selected"; source: "explicit" | "automatic"; skill: SkillContext }
  | { kind: "ambiguous"; skillIds: string[] }
  | { kind: "none" };

export type SkillInvocationEvent = {
  operation: "skill.invoked" | "skill.authorization_denied";
  result: "success" | "denied";
  actorTelegramUserId: string;
  skillId?: string;
  commitSha?: string;
  durationMs: number;
  code?: "SKILL_NOT_FOUND";
};

export class SkillResolver {
  private skills: InstalledSkill[] = [];
  constructor(
    private capabilities: CapabilityRegistry,
    skills: InstalledSkill[] = [],
    private readonly audit: (event: SkillInvocationEvent) => void = () =>
      undefined,
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
  commandCatalog(userId: string): CommandSkill[] {
    return this.skills
      .filter((skill) => this.available(skill, userId))
      .map((skill) => ({
        id: skill.id,
        name: skill.id,
        displayName: skill.name,
        purpose: skill.description ?? "No description provided",
        version: skill.commitSha,
        availability:
          skill.status === "active"
            ? ("available" as const)
            : ("retired" as const),
        supportedTasks: [
          ...(skill.triggers.phrases ?? []),
          ...(skill.triggers.keywords ?? []),
        ],
        operatingConstraints:
          skill.prohibitedActions.length > 0
            ? `Prohibited: ${skill.prohibitedActions.join("; ")}`
            : undefined,
      }));
  }
  routingCatalog(userId: string): AuthorizedSkillDescriptor[] {
    const catalog = this.skills
      .filter((skill) => this.available(skill, userId))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? "No description provided",
        status: skill.status,
        supportedTasks: skill.triggers.phrases ?? [],
        triggerHints: skill.triggers.keywords ?? [],
        permittedCapabilityIds: [...skill.tools],
      }));
    // Never silently produce a partial authorization view: that could make
    // routing dependent on installation order or hide an explicitly requested skill.
    if (catalog.length > MAX_ROUTING_SKILLS)
      throw new Error("ROUTING_SKILL_CATALOG_LIMIT_EXCEEDED");
    return structuredClone(catalog);
  }

  /** Execution-time lookup for a classifier-selected, user-authorized skill. */
  resolveRouted(skillId: string, userId: string): SkillResolution {
    const resolution = this.resolve("", userId, skillId);
    return resolution.kind === "selected"
      ? { ...resolution, source: "automatic" }
      : resolution;
  }
  resolve(text: string, userId: string, explicitId?: string): SkillResolution {
    const started = Date.now();
    if (!/^\d+$/.test(userId)) return { kind: "none" };
    const command = text.match(/^\/skill\s+([a-z0-9_.-]+)(?:\s|$)/i)?.[1];
    const selectedId = explicitId ?? command;
    if (selectedId) {
      const skill = this.skills.find(
        (item) => item.id === selectedId && this.available(item, userId),
      );
      if (!skill) {
        this.audit({
          operation: "skill.authorization_denied",
          result: "denied",
          actorTelegramUserId: userId,
          durationMs: Date.now() - started,
          code: "SKILL_NOT_FOUND",
        });
        return { kind: "none" };
      }
      this.invoked(skill, userId, started);
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
    this.invoked(candidates[0]!.skill, userId, started);
    return {
      kind: "selected",
      source: "automatic",
      skill: this.context(candidates[0]!.skill),
    };
  }
  private invoked(skill: InstalledSkill, userId: string, started: number) {
    this.audit({
      operation: "skill.invoked",
      result: "success",
      actorTelegramUserId: userId,
      skillId: skill.id,
      commitSha: skill.commitSha,
      durationMs: Date.now() - started,
    });
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
