import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SkillRevisionConflictError,
  type SkillDefinitionStore,
  type SkillVersionRecord,
} from "../../worker/skills/definition-store";
import type {
  PublishedSkillRevision,
  SaveDraftRevisionInput,
  SkillActor,
  SkillRepository,
} from "../../worker/skills/skill-repository";
import { skillDraftDigest } from "../../worker/skills/authoring-document";
import {
  executableSkillSchema,
  skillCatalogSnapshotSchema,
  skillCatalogToken,
  skillManifestSchema,
  skillMarkdownSchema,
  type ExecutableSkill,
  type SkillManifest,
} from "../../worker/skills/schemas";

const TELEGRAM_ID = /^\d+$/;

export type SkillRepositoryEvent = {
  operation:
    | "skill.catalog_loaded"
    | "skill.authorization_denied"
    | "skill.revision_conflict"
    | "skill.draft_saved"
    | "skill.pending"
    | "skill.published"
    | "skill.retired"
    | "skill.invoked";
  result: "success" | "denied" | "failure";
  durationMs: number;
  actorTelegramUserId?: string;
  skillId?: string;
  versionId?: string;
  code?: string;
};

/** Operator-owned policy. No method derives roles or capability grants from stored manifests. */
export interface SkillRepositoryAuthorizationPolicy {
  authors: ReadonlySet<string>;
  approvers: ReadonlySet<string>;
  retirees: ReadonlySet<string>;
  capabilityGrants: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface PostgresSkillRepositoryOptions {
  policy?: SkillRepositoryAuthorizationPolicy;
  audit?: (event: SkillRepositoryEvent) => void | Promise<void>;
  now?: () => number;
}

export class SkillNotFoundError extends Error {
  readonly code = "SKILL_NOT_FOUND";
  constructor() {
    super("SKILL_NOT_FOUND");
    this.name = "SkillNotFoundError";
  }
}

const DENY_ALL: SkillRepositoryAuthorizationPolicy = {
  authors: new Set(),
  approvers: new Set(),
  retirees: new Set(),
  capabilityGrants: new Map(),
};

function isAuthorized(
  manifest: Pick<
    SkillManifest,
    "visibility" | "ownerTelegramUserIds" | "allowedTelegramUserIds"
  >,
  userId: string,
) {
  return (
    manifest.visibility === "public" ||
    manifest.ownerTelegramUserIds.includes(userId) ||
    (manifest.visibility === "shared" &&
      manifest.allowedTelegramUserIds.includes(userId))
  );
}

function toExecutable(version: SkillVersionRecord): ExecutableSkill {
  const manifest = version.manifest;
  return executableSkillSchema.parse({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    versionId: version.id,
    manifestRevision: manifest.revision,
    instructions: skillMarkdownSchema.parse(version.instructions),
    visibility: manifest.visibility,
    ownerTelegramUserIds: manifest.ownerTelegramUserIds,
    allowedTelegramUserIds: manifest.allowedTelegramUserIds,
    triggers: manifest.triggers,
    tools: manifest.tools,
    prohibitedActions: manifest.prohibitedActions,
    status: manifest.status,
  });
}

export class PostgresSkillRepository implements SkillRepository {
  private readonly policy: SkillRepositoryAuthorizationPolicy;
  private readonly now: () => number;
  private readonly auditSink: (
    event: SkillRepositoryEvent,
  ) => void | Promise<void>;

  constructor(
    private readonly store: SkillDefinitionStore,
    options: PostgresSkillRepositoryOptions = {},
  ) {
    this.policy = options.policy ?? DENY_ALL;
    this.now = options.now ?? Date.now;
    this.auditSink = options.audit ?? (() => undefined);
  }

  private actor(actor: SkillActor): string {
    if (!actor || !TELEGRAM_ID.test(actor.telegramUserId))
      throw new SkillNotFoundError();
    return actor.telegramUserId;
  }

  private emit(
    event: Omit<SkillRepositoryEvent, "durationMs"> & { durationMs?: number },
  ) {
    void Promise.resolve(
      this.auditSink({ ...event, durationMs: event.durationMs ?? 0 }),
    ).catch(() => undefined);
  }

  private deny(actor: string, skillId?: string): never {
    this.emit({
      operation: "skill.authorization_denied",
      result: "denied",
      actorTelegramUserId: actor,
      ...(skillId ? { skillId } : {}),
      code: "SKILL_NOT_FOUND",
    });
    throw new SkillNotFoundError();
  }

  async loadCatalogSnapshot(actor: SkillActor) {
    const userId = this.actor(actor);
    const started = this.now();
    const published = await this.store.listCurrentPublished();
    const skills = published
      .map(({ version }) => toExecutable(version))
      .filter(
        (skill) => skill.status === "active" && isAuthorized(skill, userId),
      );
    const snapshot = skillCatalogSnapshotSchema.parse({
      catalogToken: skillCatalogToken(skills.map((skill) => skill.versionId)),
      skills,
    });
    this.emit({
      operation: "skill.catalog_loaded",
      result: "success",
      actorTelegramUserId: userId,
      durationMs: this.now() - started,
    });
    return snapshot;
  }

  async getById(
    actor: SkillActor,
    skillId: string,
    versionId?: string,
  ): Promise<ExecutableSkill | null> {
    const userId = this.actor(actor);
    if (!z.uuid().safeParse(skillId).success) return this.deny(userId);
    const skill = await this.store.getSkill(skillId);
    if (!skill || skill.status !== "active") {
      this.emit({
        operation: "skill.authorization_denied",
        result: "denied",
        actorTelegramUserId: userId,
        skillId,
        code: "SKILL_NOT_FOUND",
      });
      return null;
    }
    const resolvedId = versionId ?? skill.currentVersionId;
    if (!resolvedId) return null;
    const version = await this.store.getVersion(skillId, resolvedId);
    if (!version || version.state !== "published") return null;
    const executable = toExecutable(version);
    if (executable.status !== "active" || !isAuthorized(executable, userId)) {
      this.emit({
        operation: "skill.authorization_denied",
        result: "denied",
        actorTelegramUserId: userId,
        skillId,
        code: "SKILL_NOT_FOUND",
      });
      return null;
    }
    return executable;
  }

  async listAvailableToTelegramUser(actor: SkillActor) {
    return (await this.loadCatalogSnapshot(actor)).skills;
  }

  async saveDraftRevision(input: SaveDraftRevisionInput) {
    const actor = this.actor(input.actor);
    const manifest = skillManifestSchema.parse(input.manifest);
    if (
      !this.policy.authors.has(actor) ||
      !manifest.ownerTelegramUserIds.includes(actor)
    )
      return this.deny(actor, manifest.id);
    const grants =
      this.policy.capabilityGrants.get(manifest.ownerTelegramUserIds[0]!) ??
      new Set();
    if (manifest.tools.some((tool) => !grants.has(tool)))
      return this.deny(actor, manifest.id);
    const instructions = skillMarkdownSchema.parse(input.instructions);
    try {
      const version = await this.store.insertDraftVersion({
        skillId: manifest.id,
        name: manifest.name,
        ownerTelegramUserId: manifest.ownerTelegramUserIds[0]!,
        visibility: manifest.visibility,
        expectedRevision: input.expectedRevision,
        contentDigest:
          manifest.authoring?.contentDigest ?? skillDraftDigest(instructions),
        manifest,
        instructions,
        createdBy: actor,
      });
      this.emit({
        operation: "skill.draft_saved",
        result: "success",
        actorTelegramUserId: actor,
        skillId: manifest.id,
        versionId: version.id,
      });
      return { versionId: version.id, revision: version.revision };
    } catch (error) {
      this.handleConflict(error, actor, manifest.id);
    }
  }

  async submitForPublish(input: {
    actor: SkillActor;
    skillId: string;
    versionId: string;
    expectedRevision: number;
  }) {
    const actor = this.actor(input.actor);
    if (!this.policy.authors.has(actor)) return this.deny(actor, input.skillId);
    const version = await this.store.getVersion(input.skillId, input.versionId);
    if (
      !version ||
      !version.manifest.ownerTelegramUserIds.includes(actor) ||
      version.contentDigest.length === 0
    )
      return this.deny(actor, input.skillId);
    try {
      const pending = await this.store.markPending({
        skillId: input.skillId,
        versionId: input.versionId,
        expectedRevision: input.expectedRevision,
        contentDigest: version.contentDigest,
        actor,
      });
      this.emit({
        operation: "skill.pending",
        result: "success",
        actorTelegramUserId: actor,
        skillId: input.skillId,
        versionId: pending.id,
      });
      return { versionId: pending.id, revision: pending.revision };
    } catch (error) {
      this.handleConflict(error, actor, input.skillId);
    }
  }

  async publishApprovedRevision(input: {
    actor: SkillActor;
    skillId: string;
    expectedRevision: number;
  }): Promise<PublishedSkillRevision> {
    const actor = this.actor(input.actor);
    if (!this.policy.approvers.has(actor))
      return this.deny(actor, input.skillId);
    const pending = await this.store.getRevision(
      input.skillId,
      input.expectedRevision,
    );
    if (!pending) return this.deny(actor, input.skillId);
    const requested = toExecutable(pending);
    const grants =
      this.policy.capabilityGrants.get(requested.ownerTelegramUserIds[0]!) ??
      new Set();
    if (requested.tools.some((tool) => !grants.has(tool)))
      return this.deny(actor, input.skillId);
    try {
      const version = await this.store.publish({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actor,
      });
      const skill = toExecutable(version);
      this.emit({
        operation: "skill.published",
        result: "success",
        actorTelegramUserId: actor,
        skillId: input.skillId,
        versionId: version.id,
      });
      return { skill, versionId: version.id };
    } catch (error) {
      this.handleConflict(error, actor, input.skillId);
    }
  }

  async retire(input: {
    actor: SkillActor;
    skillId: string;
    expectedRevision: number;
  }) {
    const actor = this.actor(input.actor);
    if (!this.policy.retirees.has(actor))
      return this.deny(actor, input.skillId);
    const current = await this.getById(input.actor, input.skillId);
    if (!current || current.manifestRevision !== input.expectedRevision)
      return this.deny(actor, input.skillId);
    const version = await this.store.getVersion(
      input.skillId,
      current.versionId,
    );
    if (!version) return this.deny(actor, input.skillId);
    const manifest = skillManifestSchema.parse({
      ...version.manifest,
      status: "retired",
      revision: input.expectedRevision + 1,
    });
    try {
      const retired = await this.store.retire({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actor,
        manifest,
        instructions: version.instructions,
        contentDigest: version.contentDigest,
      });
      this.emit({
        operation: "skill.retired",
        result: "success",
        actorTelegramUserId: actor,
        skillId: input.skillId,
        versionId: retired.id,
      });
      return { versionId: retired.id, revision: retired.revision };
    } catch (error) {
      this.handleConflict(error, actor, input.skillId);
    }
  }

  async authorizeInvocation(input: {
    actor: SkillActor;
    skillId: string;
    versionId?: string;
  }): Promise<ExecutableSkill> {
    const actor = this.actor(input.actor);
    const skill = await this.getById(
      input.actor,
      input.skillId,
      input.versionId,
    );
    if (!skill) return this.deny(actor, input.skillId);
    const grants = this.policy.capabilityGrants.get(actor) ?? new Set();
    if (skill.tools.some((tool) => !grants.has(tool)))
      return this.deny(actor, input.skillId);
    this.emit({
      operation: "skill.invoked",
      result: "success",
      actorTelegramUserId: actor,
      skillId: skill.id,
      versionId: skill.versionId,
    });
    return skill;
  }

  private handleConflict(
    error: unknown,
    actor: string,
    skillId?: string,
  ): never {
    if (error instanceof SkillRevisionConflictError) {
      this.emit({
        operation: "skill.revision_conflict",
        result: "failure",
        actorTelegramUserId: actor,
        ...(skillId ? { skillId } : {}),
        code: "SKILL_REVISION_CONFLICT",
      });
      throw error;
    }
    throw error;
  }
}

export function newVersionId(): string {
  return randomUUID();
}
