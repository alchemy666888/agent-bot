import { randomUUID } from "node:crypto";
import type { SkillManifest } from "./schemas";

export type SkillVersionState = "draft" | "pending" | "published" | "retired";

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  revision: number;
  contentDigest: string;
  manifest: SkillManifest;
  instructions: string;
  state: SkillVersionState;
  createdBy: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  ownerTelegramUserId: string;
  visibility: SkillManifest["visibility"];
  status: "active" | "retired";
  currentVersionId: string | null;
}

export class SkillRevisionConflictError extends Error {
  readonly code = "SKILL_REVISION_CONFLICT";
  constructor() {
    super("SKILL_REVISION_CONFLICT");
    this.name = "SkillRevisionConflictError";
  }
}

export interface InsertDraftVersionInput {
  versionId?: string;
  skillId: string;
  name: string;
  ownerTelegramUserId: string;
  visibility: SkillManifest["visibility"];
  expectedRevision: number;
  contentDigest: string;
  manifest: SkillManifest;
  instructions: string;
  createdBy: string;
}

export interface SkillDefinitionStore {
  insertDraftVersion(
    input: InsertDraftVersionInput,
  ): Promise<SkillVersionRecord>;
  markPending(input: {
    skillId: string;
    versionId: string;
    expectedRevision: number;
    contentDigest: string;
    actor: string;
  }): Promise<SkillVersionRecord>;
  publish(input: {
    skillId: string;
    expectedRevision: number;
    actor: string;
  }): Promise<SkillVersionRecord>;
  retire(input: {
    skillId: string;
    expectedRevision: number;
    actor: string;
    versionId?: string;
    manifest: SkillManifest;
    instructions: string;
    contentDigest: string;
  }): Promise<SkillVersionRecord>;
  getVersion(
    skillId: string,
    versionId: string,
  ): Promise<SkillVersionRecord | null>;
  getRevision(
    skillId: string,
    revision: number,
  ): Promise<SkillVersionRecord | null>;
  getSkill(skillId: string): Promise<SkillRecord | null>;
  listCurrentPublished(): Promise<
    Array<{ skill: SkillRecord; version: SkillVersionRecord }>
  >;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory store with the same revision and immutability rules as PostgreSQL. */
export class MemorySkillDefinitionStore implements SkillDefinitionStore {
  readonly skills = new Map<string, SkillRecord>();
  readonly versions: SkillVersionRecord[] = [];

  private latest(skillId: string): number {
    return this.versions
      .filter((version) => version.skillId === skillId)
      .reduce((max, version) => Math.max(max, version.revision), 0);
  }

  private find(
    skillId: string,
    versionId: string,
  ): SkillVersionRecord | undefined {
    return this.versions.find(
      (version) => version.skillId === skillId && version.id === versionId,
    );
  }

  async insertDraftVersion(
    input: InsertDraftVersionInput,
  ): Promise<SkillVersionRecord> {
    if (this.latest(input.skillId) !== input.expectedRevision)
      throw new SkillRevisionConflictError();
    let skill = this.skills.get(input.skillId);
    if (!skill) {
      skill = {
        id: input.skillId,
        name: input.name,
        ownerTelegramUserId: input.ownerTelegramUserId,
        visibility: input.visibility,
        status: "active",
        currentVersionId: null,
      };
      this.skills.set(input.skillId, skill);
    }
    const record: SkillVersionRecord = {
      id: input.versionId ?? randomUUID(),
      skillId: input.skillId,
      revision: input.expectedRevision + 1,
      contentDigest: input.contentDigest,
      manifest: clone(input.manifest),
      instructions: input.instructions,
      state: "draft",
      createdBy: input.createdBy,
    };
    this.versions.push(record);
    return clone(record);
  }

  async markPending(input: {
    skillId: string;
    versionId: string;
    expectedRevision: number;
    contentDigest: string;
    actor: string;
  }): Promise<SkillVersionRecord> {
    const version = this.find(input.skillId, input.versionId);
    if (
      !version ||
      version.revision !== input.expectedRevision ||
      version.contentDigest !== input.contentDigest ||
      this.latest(input.skillId) !== input.expectedRevision
    )
      throw new SkillRevisionConflictError();
    if (version.state === "pending") return clone(version);
    if (version.state !== "draft") throw new SkillRevisionConflictError();
    version.state = "pending";
    void input.actor;
    return clone(version);
  }

  async publish(input: {
    skillId: string;
    expectedRevision: number;
    actor: string;
  }): Promise<SkillVersionRecord> {
    const skill = this.skills.get(input.skillId);
    const version = this.versions.find(
      (item) =>
        item.skillId === input.skillId &&
        item.revision === input.expectedRevision,
    );
    if (
      !skill ||
      !version ||
      this.latest(input.skillId) !== input.expectedRevision
    )
      throw new SkillRevisionConflictError();
    if (version.state === "published" && skill.currentVersionId === version.id)
      return clone(version);
    if (version.state !== "pending") throw new SkillRevisionConflictError();
    version.state = "published";
    skill.currentVersionId = version.id;
    skill.name = version.manifest.name;
    skill.visibility = version.manifest.visibility;
    skill.status = "active";
    skill.ownerTelegramUserId = version.manifest.ownerTelegramUserIds[0]!;
    void input.actor;
    return clone(version);
  }

  async retire(input: {
    skillId: string;
    expectedRevision: number;
    actor: string;
    versionId?: string;
    manifest: SkillManifest;
    instructions: string;
    contentDigest: string;
  }): Promise<SkillVersionRecord> {
    const skill = this.skills.get(input.skillId);
    if (!skill || this.latest(input.skillId) !== input.expectedRevision)
      throw new SkillRevisionConflictError();
    const record: SkillVersionRecord = {
      id: input.versionId ?? randomUUID(),
      skillId: input.skillId,
      revision: input.expectedRevision + 1,
      contentDigest: input.contentDigest,
      manifest: clone(input.manifest),
      instructions: input.instructions,
      state: "retired",
      createdBy: input.actor,
    };
    this.versions.push(record);
    skill.status = "retired";
    skill.currentVersionId = record.id;
    return clone(record);
  }

  async getVersion(
    skillId: string,
    versionId: string,
  ): Promise<SkillVersionRecord | null> {
    const version = this.find(skillId, versionId);
    return version ? clone(version) : null;
  }

  async getRevision(
    skillId: string,
    revision: number,
  ): Promise<SkillVersionRecord | null> {
    const version = this.versions.find(
      (item) => item.skillId === skillId && item.revision === revision,
    );
    return version ? clone(version) : null;
  }

  async getSkill(skillId: string): Promise<SkillRecord | null> {
    const skill = this.skills.get(skillId);
    return skill ? clone(skill) : null;
  }

  async listCurrentPublished(): Promise<
    Array<{ skill: SkillRecord; version: SkillVersionRecord }>
  > {
    const rows: Array<{ skill: SkillRecord; version: SkillVersionRecord }> = [];
    for (const skill of this.skills.values()) {
      if (skill.status !== "active" || !skill.currentVersionId) continue;
      const version = this.find(skill.id, skill.currentVersionId);
      if (!version || version.state !== "published") continue;
      rows.push({ skill: clone(skill), version: clone(version) });
    }
    return rows;
  }
}
