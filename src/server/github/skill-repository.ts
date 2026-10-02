import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PublishedSkillRevision,
  SaveDraftRevisionInput,
  SkillActor,
  SkillRepository,
} from "../../worker/skills/skill-repository";
import {
  executableSkillSchema,
  skillCatalogSnapshotSchema,
  skillManifestSchema,
  skillMarkdownSchema,
  type ExecutableSkill,
  type SkillManifest,
} from "../../worker/skills/schemas";
import { GitHubSkillsClient, GitHubSkillsError } from "./skills-client";
import type { SkillDraftGitClient } from "../skills/repository";

/** GitHub adapter used only by the trusted server-side authoring coordinator. */
export class GitHubSkillAuthoringAdapter
  extends GitHubSkillsClient
  implements SkillDraftGitClient {}

const INDEX_FILE = "index.json";
const CACHE_TTL_MS = 30_000;
const STALE_IF_ERROR_MS = 120_000;
const SHA = /^[a-f0-9]{40}$/i;
const TELEGRAM_ID = /^\d+$/;

const catalogIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z.array(
      z
        .object({
          id: z.uuid(),
          directory: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = new Set<string>();
    const directories = new Set<string>();
    index.skills.forEach((skill, position) => {
      if (ids.has(skill.id) || directories.has(skill.directory))
        ctx.addIssue({
          code: "custom",
          path: ["skills", position],
          message: "Duplicate skill id or directory",
        });
      ids.add(skill.id);
      directories.add(skill.directory);
    });
  });

type CatalogIndex = z.infer<typeof catalogIndexSchema>;
type CacheEntry = {
  commitSha: string;
  validatedAt: number;
  freshUntil: number;
  staleUntil: number;
  skills: ExecutableSkill[];
};

export type SkillRepositoryEvent = {
  operation:
    | "github.read"
    | "github.branch_created"
    | "github.commit"
    | "github.pull_request_created"
    | "github.merge_observed"
    | "skill.catalog_refreshed"
    | "skill.authorization_denied"
    | "skill.revision_conflict"
    | "github.rate_limited"
    | "skill.invoked";
  result: "success" | "denied" | "failure" | "degraded";
  durationMs: number;
  actorTelegramUserId?: string;
  skillId?: string;
  draftId?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  code?: string;
};

/** Operator-owned policy. No method derives roles or capability grants from Git. */
export interface SkillRepositoryAuthorizationPolicy {
  authors: ReadonlySet<string>;
  approvers: ReadonlySet<string>;
  retirees: ReadonlySet<string>;
  capabilityGrants: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface GitHubSkillRepositoryOptions {
  cacheTtlMs?: number;
  staleIfErrorMs?: number;
  now?: () => number;
  policy?: SkillRepositoryAuthorizationPolicy;
  audit?: (event: SkillRepositoryEvent) => void | Promise<void>;
}

export class SkillNotFoundError extends Error {
  readonly code = "SKILL_NOT_FOUND";
  constructor() {
    super("SKILL_NOT_FOUND");
    this.name = "SkillNotFoundError";
  }
}

export class SkillRevisionConflictError extends Error {
  readonly code = "SKILL_REVISION_CONFLICT";
  constructor() {
    super("SKILL_REVISION_CONFLICT");
    this.name = "SkillRevisionConflictError";
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

function safeDirectory(prefix: string, directory: string): string {
  if (
    directory.includes("..") ||
    directory.startsWith("/") ||
    directory.includes("\\")
  )
    throw new TypeError("Unsafe catalog directory");
  return `${prefix}/${directory}`;
}

function transientRead(error: unknown): boolean {
  return (
    error instanceof GitHubSkillsError &&
    (error.kind === "transient" || error.kind === "rate_limit")
  );
}

/** Repository/service boundary that performs authorization before returning any skill data. */
export class GitHubSkillRepository implements SkillRepository {
  private readonly byCommit = new Map<string, CacheEntry>();
  private readonly byRef = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly writeTails = new Map<string, Promise<void>>();
  private readonly cacheTtlMs: number;
  private readonly staleIfErrorMs: number;
  private readonly now: () => number;
  private readonly policy: SkillRepositoryAuthorizationPolicy;
  private readonly auditSink: (
    event: SkillRepositoryEvent,
  ) => void | Promise<void>;

  constructor(
    private readonly client: GitHubSkillsClient,
    options: GitHubSkillRepositoryOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.staleIfErrorMs = options.staleIfErrorMs ?? STALE_IF_ERROR_MS;
    this.now = options.now ?? Date.now;
    this.policy = options.policy ?? DENY_ALL;
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

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.writeTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => tail);
    this.writeTails.set(key, queued);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.writeTails.get(key) === queued) this.writeTails.delete(key);
    }
  }

  private async readIndex(ref: string): Promise<CatalogIndex> {
    const file = await this.client.readFile(
      `${this.client.controlledPrefix}/${INDEX_FILE}`,
      ref,
    );
    return catalogIndexSchema.parse(JSON.parse(file.content));
  }

  private async readSkill(
    entry: CatalogIndex["skills"][number],
    commitSha: string,
  ): Promise<ExecutableSkill> {
    const directory = safeDirectory(
      this.client.controlledPrefix,
      entry.directory,
    );
    const [manifestFile, markdownFile] = await Promise.all([
      this.client.readFile(`${directory}/manifest.json`, commitSha),
      this.client.readFile(`${directory}/SKILL.md`, commitSha),
    ]);
    const manifest = skillManifestSchema.parse(
      JSON.parse(manifestFile.content),
    );
    if (manifest.id !== entry.id) throw new Error("SKILL_INDEX_ID_MISMATCH");
    return executableSkillSchema.parse({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      commitSha,
      manifestRevision: manifest.revision,
      instructions: skillMarkdownSchema.parse(markdownFile.content),
      visibility: manifest.visibility,
      ownerTelegramUserIds: manifest.ownerTelegramUserIds,
      allowedTelegramUserIds: manifest.allowedTelegramUserIds,
      triggers: manifest.triggers,
      tools: manifest.tools,
      prohibitedActions: manifest.prohibitedActions,
      status: manifest.status,
    });
  }

  private async refresh(commitSha: string): Promise<CacheEntry> {
    const existing = this.inFlight.get(commitSha);
    if (existing) return existing;
    const started = this.now();
    const request = (async () => {
      const index = await this.readIndex(commitSha);
      const skills = await Promise.all(
        index.skills.map((entry) => this.readSkill(entry, commitSha)),
      );
      skillCatalogSnapshotSchema.parse({ commitSha, skills });
      const validatedAt = this.now();
      const entry = {
        commitSha,
        validatedAt,
        freshUntil: validatedAt + this.cacheTtlMs,
        staleUntil: validatedAt + this.cacheTtlMs + this.staleIfErrorMs,
        skills,
      };
      this.byCommit.set(commitSha, entry);
      this.emit({
        operation: "skill.catalog_refreshed",
        result: "success",
        commitSha,
        durationMs: this.now() - started,
      });
      return entry;
    })();
    this.inFlight.set(commitSha, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(commitSha);
    }
  }

  private async catalog(ref?: string): Promise<CacheEntry> {
    const refKey = ref ?? this.client.defaultBranch;
    const immutable = SHA.test(refKey);
    const prior = this.byRef.get(refKey);
    try {
      const commitSha = immutable
        ? refKey
        : await this.client.getBranchHead(refKey);
      const cached = this.byCommit.get(commitSha);
      const entry =
        cached && cached.freshUntil > this.now()
          ? cached
          : await this.refresh(commitSha);
      this.byRef.set(refKey, entry);
      this.emit({
        operation: "github.read",
        result: "success",
        commitSha,
        durationMs: 0,
      });
      return entry;
    } catch (error) {
      if (error instanceof GitHubSkillsError && error.kind === "rate_limit")
        this.emit({
          operation: "github.rate_limited",
          result: "failure",
          durationMs: 0,
          code: "GITHUB_RATE_LIMITED",
        });
      // Only a previously schema-validated snapshot, for the same symbolic ref,
      // and only inside the explicit stale window may survive a transient read.
      if (
        !immutable &&
        transientRead(error) &&
        prior &&
        prior.staleUntil > this.now()
      ) {
        this.emit({
          operation: "github.read",
          result: "degraded",
          commitSha: prior.commitSha,
          durationMs: 0,
          code: "STALE_VALIDATED_CATALOG",
        });
        return prior;
      }
      throw error;
    }
  }

  async loadCatalogSnapshot(actor: SkillActor, ref?: string) {
    const userId = this.actor(actor);
    const entry = await this.catalog(ref);
    const skills = entry.skills.filter(
      (skill) => skill.status === "active" && isAuthorized(skill, userId),
    );
    return skillCatalogSnapshotSchema.parse({
      commitSha: entry.commitSha,
      skills,
    });
  }

  async getById(
    actor: SkillActor,
    skillId: string,
    ref?: string,
  ): Promise<ExecutableSkill | null> {
    const userId = this.actor(actor);
    if (!z.uuid().safeParse(skillId).success) return this.deny(userId);
    const skill = (await this.catalog(ref)).skills.find(
      (item) => item.id === skillId && item.status === "active",
    );
    if (!skill || !isAuthorized(skill, userId)) {
      this.emit({
        operation: "skill.authorization_denied",
        result: "denied",
        actorTelegramUserId: userId,
        skillId,
        code: "SKILL_NOT_FOUND",
      });
      return null;
    }
    return structuredClone(skill);
  }

  async listAvailableToTelegramUser(actor: SkillActor, ref?: string) {
    return (await this.loadCatalogSnapshot(actor, ref)).skills;
  }

  async createDraftBranch(input: {
    actor: SkillActor;
    skillId: string;
    fromRef?: string;
    branch?: string;
  }) {
    const actor = this.actor(input.actor);
    if (
      !this.policy.authors.has(actor) ||
      !z.uuid().safeParse(input.skillId).success
    )
      return this.deny(actor);
    return this.locked(input.skillId, async () => {
      const started = this.now();
      const baseCommitSha =
        input.fromRef && SHA.test(input.fromRef)
          ? input.fromRef
          : await this.client.getBranchHead(input.fromRef);
      const branch = input.branch ?? `skill/${input.skillId}/${randomUUID()}`;
      try {
        await this.client.createBranch(branch, baseCommitSha);
        this.emit({
          operation: "github.branch_created",
          result: "success",
          actorTelegramUserId: actor,
          skillId: input.skillId,
          commitSha: baseCommitSha,
          durationMs: this.now() - started,
        });
        return { branch, baseCommitSha };
      } catch (error) {
        this.handleWriteError(error, actor, input.skillId);
      }
    });
  }

  async saveDraftRevision(input: SaveDraftRevisionInput) {
    const actor = this.actor(input.actor);
    if (
      !this.policy.authors.has(actor) ||
      !input.manifest.ownerTelegramUserIds.includes(actor)
    )
      return this.deny(actor);
    return this.locked(input.manifest.id, async () => {
      const started = this.now();
      try {
        let expectedHead = input.expectedBranchSha;
        await this.assertHead(input.branch, expectedHead);
        const manifest = skillManifestSchema.parse(input.manifest);
        const grants =
          this.policy.capabilityGrants.get(manifest.ownerTelegramUserIds[0]!) ??
          new Set();
        if (manifest.tools.some((tool) => !grants.has(tool)))
          return this.deny(actor, manifest.id);
        const instructions = skillMarkdownSchema.parse(input.instructions);
        const indexFile = await this.client.readFile(
          `${this.client.controlledPrefix}/${INDEX_FILE}`,
          expectedHead,
        );
        if (
          input.expectedIndexSha != null &&
          indexFile.sha !== input.expectedIndexSha
        )
          throw new SkillRevisionConflictError();
        const index = catalogIndexSchema.parse(JSON.parse(indexFile.content));
        const current = index.skills.find((entry) => entry.id === manifest.id);
        if (current && current.directory !== input.directory)
          throw new SkillRevisionConflictError();
        const directory = safeDirectory(
          this.client.controlledPrefix,
          input.directory,
        );
        const manifestWrite = await this.client.putFile({
          path: `${directory}/manifest.json`,
          branch: input.branch,
          content: `${JSON.stringify(manifest, null, 2)}\n`,
          message: input.message,
          expectedSha: input.expectedManifestSha ?? null,
        });
        expectedHead = manifestWrite.commitSha;
        await this.assertHead(input.branch, expectedHead);
        const skillWrite = await this.client.putFile({
          path: `${directory}/SKILL.md`,
          branch: input.branch,
          content: instructions,
          message: input.message,
          expectedSha: input.expectedSkillSha ?? null,
        });
        expectedHead = skillWrite.commitSha;
        if (!current) {
          await this.assertHead(input.branch, expectedHead);
          index.skills.push({ id: manifest.id, directory: input.directory });
          index.skills.sort((a, b) => a.id.localeCompare(b.id));
          const write = await this.client.putFile({
            path: `${this.client.controlledPrefix}/${INDEX_FILE}`,
            branch: input.branch,
            content: `${JSON.stringify(catalogIndexSchema.parse(index), null, 2)}\n`,
            message: input.message,
            expectedSha: indexFile.sha,
          });
          expectedHead = write.commitSha;
        }
        this.clearCache();
        this.emit({
          operation: "github.commit",
          result: "success",
          actorTelegramUserId: actor,
          skillId: manifest.id,
          commitSha: expectedHead,
          durationMs: this.now() - started,
        });
        return { commitSha: expectedHead };
      } catch (error) {
        this.handleWriteError(error, actor, input.manifest.id);
      }
    });
  }

  async publishApprovedRevision(input: {
    actor: SkillActor;
    pullRequestNumber: number;
    skillId: string;
    expectedMergeCommitSha: string;
  }): Promise<PublishedSkillRevision> {
    const actor = this.actor(input.actor);
    if (!this.policy.approvers.has(actor)) return this.deny(actor);
    return this.locked(input.skillId, async () => {
      try {
        const pull = await this.client.getPullRequest(input.pullRequestNumber);
        if (
          !pull.merged ||
          pull.merge_commit_sha !== input.expectedMergeCommitSha
        )
          throw new SkillRevisionConflictError();
        const head = await this.client.getBranchHead();
        if (head !== input.expectedMergeCommitSha)
          throw new SkillRevisionConflictError();
        const skill = (await this.catalog(head)).skills.find(
          (candidate) =>
            candidate.id === input.skillId && candidate.status === "active",
        );
        if (!skill) return this.deny(actor);
        const grants =
          this.policy.capabilityGrants.get(skill.ownerTelegramUserIds[0]!) ??
          new Set();
        if (skill.tools.some((tool) => !grants.has(tool)))
          return this.deny(actor);
        this.emit({
          operation: "github.merge_observed",
          result: "success",
          actorTelegramUserId: actor,
          skillId: input.skillId,
          commitSha: head,
          pullRequestNumber: pull.number,
          durationMs: 0,
        });
        return { skill, pullRequestNumber: pull.number };
      } catch (error) {
        this.handleWriteError(error, actor, input.skillId);
      }
    });
  }

  async retire(input: {
    actor: SkillActor;
    skillId: string;
    branch: string;
    expectedBranchSha: string;
    expectedManifestSha: string;
  }) {
    const actor = this.actor(input.actor);
    if (!this.policy.retirees.has(actor)) return this.deny(actor);
    return this.locked(input.skillId, async () => {
      try {
        await this.assertHead(input.branch, input.expectedBranchSha);
        const skill = await this.getById(
          input.actor,
          input.skillId,
          input.expectedBranchSha,
        );
        if (!skill) return this.deny(actor);
        const index = await this.readIndex(input.expectedBranchSha);
        const entry = index.skills.find(
          (candidate) => candidate.id === input.skillId,
        );
        if (!entry) return this.deny(actor);
        const path = `${safeDirectory(this.client.controlledPrefix, entry.directory)}/manifest.json`;
        const current = await this.client.readFile(
          path,
          input.expectedBranchSha,
        );
        if (current.sha !== input.expectedManifestSha)
          throw new SkillRevisionConflictError();
        const manifest = skillManifestSchema.parse(JSON.parse(current.content));
        const write = await this.client.putFile({
          path,
          branch: input.branch,
          content: `${JSON.stringify({ ...manifest, status: "retired" }, null, 2)}\n`,
          message: `Retire skill ${input.skillId}`,
          expectedSha: input.expectedManifestSha,
        });
        this.clearCache();
        this.emit({
          operation: "github.commit",
          result: "success",
          actorTelegramUserId: actor,
          skillId: input.skillId,
          commitSha: write.commitSha,
          durationMs: 0,
        });
        return { commitSha: write.commitSha };
      } catch (error) {
        this.handleWriteError(error, actor, input.skillId);
      }
    });
  }

  async authorizeInvocation(input: {
    actor: SkillActor;
    skillId: string;
    ref?: string;
  }): Promise<ExecutableSkill> {
    const actor = this.actor(input.actor);
    const skill = await this.getById(input.actor, input.skillId, input.ref);
    if (!skill) return this.deny(actor);
    const grants = this.policy.capabilityGrants.get(actor) ?? new Set();
    if (skill.tools.some((tool) => !grants.has(tool))) return this.deny(actor);
    this.emit({
      operation: "skill.invoked",
      result: "success",
      actorTelegramUserId: actor,
      skillId: skill.id,
      commitSha: skill.commitSha,
      durationMs: 0,
    });
    return skill;
  }

  private async assertHead(branch: string, expected: string) {
    if (
      !SHA.test(expected) ||
      (await this.client.getBranchHead(branch)) !== expected
    )
      throw new SkillRevisionConflictError();
  }

  private clearCache() {
    this.byCommit.clear();
    this.byRef.clear();
  }

  private handleWriteError(
    error: unknown,
    actor: string,
    skillId?: string,
  ): never {
    if (
      error instanceof SkillRevisionConflictError ||
      (error instanceof GitHubSkillsError && error.kind === "conflict")
    ) {
      this.emit({
        operation: "skill.revision_conflict",
        result: "failure",
        actorTelegramUserId: actor,
        ...(skillId ? { skillId } : {}),
        durationMs: 0,
        code: "SKILL_REVISION_CONFLICT",
      });
      throw new SkillRevisionConflictError();
    }
    if (error instanceof GitHubSkillsError && error.kind === "rate_limit")
      this.emit({
        operation: "github.rate_limited",
        result: "failure",
        actorTelegramUserId: actor,
        durationMs: 0,
        code: "GITHUB_RATE_LIMITED",
      });
    throw error;
  }
}
