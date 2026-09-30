import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PublishedSkillRevision,
  SaveDraftRevisionInput,
  SkillRepository,
} from "../../worker/skills/skill-repository";
import {
  executableSkillSchema,
  skillManifestSchema,
  skillMarkdownSchema,
  type ExecutableSkill,
  type SkillManifest,
} from "../../worker/skills/schemas";
import { GitHubSkillsClient } from "./skills-client";

const INDEX_FILE = "index.json";
const CACHE_TTL_MS = 30_000;
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
    for (const [position, skill] of index.skills.entries()) {
      if (ids.has(skill.id) || directories.has(skill.directory))
        ctx.addIssue({
          code: "custom",
          path: ["skills", position],
          message: "Duplicate skill id or directory",
        });
      ids.add(skill.id);
      directories.add(skill.directory);
    }
  });

type CatalogIndex = z.infer<typeof catalogIndexSchema>;
type CacheEntry = { expiresAt: number; skills: ExecutableSkill[] };

function authorized(
  manifest: Pick<
    SkillManifest,
    "visibility" | "ownerTelegramUserIds" | "allowedTelegramUserIds"
  >,
  userId: string,
): boolean {
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

export class GitHubSkillRepository implements SkillRepository {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: GitHubSkillsClient,
    private readonly cacheTtlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private async resolveRef(ref?: string): Promise<string> {
    if (ref && /^[a-f0-9]{40}$/i.test(ref)) return ref;
    return this.client.getBranchHead(ref);
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
    const instructions = skillMarkdownSchema.parse(markdownFile.content);
    return executableSkillSchema.parse({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      commitSha,
      manifestRevision: manifest.revision,
      instructions,
      visibility: manifest.visibility,
      ownerTelegramUserIds: manifest.ownerTelegramUserIds,
      allowedTelegramUserIds: manifest.allowedTelegramUserIds,
      triggers: manifest.triggers,
      tools: manifest.tools,
      prohibitedActions: manifest.prohibitedActions,
      status: manifest.status,
    });
  }

  private async catalog(ref?: string): Promise<ExecutableSkill[]> {
    const commitSha = await this.resolveRef(ref);
    const cached = this.cache.get(commitSha);
    if (cached && cached.expiresAt > this.now()) return cached.skills;
    const index = await this.readIndex(commitSha);
    const skills = await Promise.all(
      index.skills.map((entry) => this.readSkill(entry, commitSha)),
    );
    this.cache.clear();
    this.cache.set(commitSha, {
      expiresAt: this.now() + this.cacheTtlMs,
      skills,
    });
    return skills;
  }

  async getById(
    skillId: string,
    ref?: string,
  ): Promise<ExecutableSkill | null> {
    z.uuid().parse(skillId);
    return (
      (await this.catalog(ref)).find((skill) => skill.id === skillId) ?? null
    );
  }

  async listAvailableToTelegramUser(userId: string, ref?: string) {
    z.string().regex(/^\d+$/).parse(userId);
    return (await this.catalog(ref)).filter(
      (skill) => skill.status === "active" && authorized(skill, userId),
    );
  }

  async createDraftBranch(input: {
    skillId: string;
    fromRef?: string;
    branch?: string;
  }) {
    z.uuid().parse(input.skillId);
    const baseCommitSha = await this.resolveRef(input.fromRef);
    const branch = input.branch ?? `skill/${input.skillId}/${randomUUID()}`;
    await this.client.createBranch(branch, baseCommitSha);
    return { branch, baseCommitSha };
  }

  async saveDraftRevision(input: SaveDraftRevisionInput) {
    const manifest = skillManifestSchema.parse(input.manifest);
    const instructions = skillMarkdownSchema.parse(input.instructions);
    const index = await this.readIndex(input.branch);
    const current = index.skills.find((entry) => entry.id === manifest.id);
    if (current && current.directory !== input.directory)
      throw new Error("SKILL_DIRECTORY_CHANGED");
    const directory = safeDirectory(
      this.client.controlledPrefix,
      input.directory,
    );
    await this.client.putFile({
      path: `${directory}/manifest.json`,
      branch: input.branch,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      message: input.message,
      expectedSha: input.expectedManifestSha ?? null,
    });
    const skillWrite = await this.client.putFile({
      path: `${directory}/SKILL.md`,
      branch: input.branch,
      content: instructions,
      message: input.message,
      expectedSha: input.expectedSkillSha ?? null,
    });
    if (!current) {
      index.skills.push({ id: manifest.id, directory: input.directory });
      index.skills.sort((a, b) => a.id.localeCompare(b.id));
      await this.client.putFile({
        path: `${this.client.controlledPrefix}/${INDEX_FILE}`,
        branch: input.branch,
        content: `${JSON.stringify(catalogIndexSchema.parse(index), null, 2)}\n`,
        message: input.message,
        expectedSha: (
          await this.client.readFile(
            `${this.client.controlledPrefix}/${INDEX_FILE}`,
            input.branch,
          )
        ).sha,
      });
    }
    this.cache.clear();
    return { commitSha: skillWrite.commitSha };
  }

  async publishApprovedRevision(input: {
    pullRequestNumber: number;
    skillId: string;
  }): Promise<PublishedSkillRevision> {
    const pull = await this.client.getPullRequest(input.pullRequestNumber);
    if (!pull.merged) throw new Error("SKILL_REVISION_NOT_MERGED");
    const head = await this.client.getBranchHead();
    const skill = await this.getById(input.skillId, head);
    if (!skill) throw new Error("SKILL_NOT_FOUND");
    return { skill, pullRequestNumber: pull.number };
  }

  async retire(input: {
    skillId: string;
    branch: string;
    actorTelegramUserId: string;
  }) {
    const skill = await this.getById(input.skillId, input.branch);
    if (!skill) throw new Error("SKILL_NOT_FOUND");
    if (!skill.ownerTelegramUserIds.includes(input.actorTelegramUserId))
      throw new Error("SKILL_NOT_AUTHORIZED");
    const index = await this.readIndex(input.branch);
    const entry = index.skills.find(
      (candidate) => candidate.id === input.skillId,
    )!;
    const path = `${safeDirectory(this.client.controlledPrefix, entry.directory)}/manifest.json`;
    const current = await this.client.readFile(path, input.branch);
    const manifest = skillManifestSchema.parse(JSON.parse(current.content));
    const write = await this.client.putFile({
      path,
      branch: input.branch,
      content: `${JSON.stringify({ ...manifest, status: "retired" }, null, 2)}\n`,
      message: `Retire skill ${input.skillId}`,
      expectedSha: current.sha,
    });
    this.cache.clear();
    return { commitSha: write.commitSha };
  }
}
