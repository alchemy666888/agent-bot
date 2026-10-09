import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresSkillRepository } from "../../../src/server/skills/postgres-skill-repository";
import {
  MemorySkillDefinitionStore,
  SkillRevisionConflictError,
} from "../../../src/worker/skills/definition-store";
import type { SkillManifest } from "../../../src/worker/skills/schemas";

const SKILL_ID = randomUUID();
const owner = { telegramUserId: "123" };
const stranger = { telegramUserId: "999" };
const approver = { telegramUserId: "200" };

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schemaVersion: 1,
    id: SKILL_ID,
    name: "Weather",
    description: "Forecasts",
    revision: 1,
    visibility: "private",
    ownerTelegramUserIds: ["123"],
    allowedTelegramUserIds: [],
    triggers: { phrases: [], keywords: ["weather"], minimumConfidence: 0.8 },
    tools: ["weather.lookup"],
    prohibitedActions: [],
    status: "active",
    ...overrides,
  };
}

function repository(store = new MemorySkillDefinitionStore()) {
  const repo = new PostgresSkillRepository(store, {
    policy: {
      authors: new Set(["123"]),
      approvers: new Set(["200"]),
      retirees: new Set(["123"]),
      capabilityGrants: new Map([["123", new Set(["weather.lookup"])]]),
    },
  });
  return { repo, store };
}

describe("PostgreSQL skill repository", () => {
  it("hides pending revisions and publishes only after an approver", async () => {
    const { repo } = repository();
    const draft = await repo.saveDraftRevision({
      actor: owner,
      manifest: manifest(),
      instructions: "# Weather\nForecast.",
      expectedRevision: 0,
    });
    expect(await repo.listAvailableToTelegramUser(owner)).toEqual([]);
    await repo.submitForPublish({
      actor: owner,
      skillId: SKILL_ID,
      versionId: draft.versionId,
      expectedRevision: draft.revision,
    });
    expect(await repo.getById(owner, SKILL_ID)).toBeNull();
    await expect(
      repo.authorizeInvocation({ actor: owner, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    const published = await repo.publishApprovedRevision({
      actor: approver,
      skillId: SKILL_ID,
      expectedRevision: draft.revision,
    });
    expect(published.skill).toMatchObject({
      id: SKILL_ID,
      versionId: draft.versionId,
      manifestRevision: 1,
    });
    expect(await repo.listAvailableToTelegramUser(owner)).toEqual([
      expect.objectContaining({ id: SKILL_ID, versionId: draft.versionId }),
    ]);
    expect(await repo.listAvailableToTelegramUser(stranger)).toEqual([]);
  });

  it("makes missing and unauthorized reads indistinguishable", async () => {
    const { repo } = repository();
    const draft = await repo.saveDraftRevision({
      actor: owner,
      manifest: manifest({ visibility: "public", tools: [] }),
      instructions: "# Weather\nForecast.",
      expectedRevision: 0,
    });
    await repo.submitForPublish({
      actor: owner,
      skillId: SKILL_ID,
      versionId: draft.versionId,
      expectedRevision: 1,
    });
    await repo.publishApprovedRevision({
      actor: approver,
      skillId: SKILL_ID,
      expectedRevision: 1,
    });
    expect(await repo.getById(stranger, randomUUID())).toBeNull();
    await expect(
      repo.authorizeInvocation({
        actor: stranger,
        skillId: SKILL_ID,
        versionId: draft.versionId,
      }),
    ).resolves.toMatchObject({ id: SKILL_ID });
    const privateRepo = repository();
    const hidden = await privateRepo.repo.saveDraftRevision({
      actor: owner,
      manifest: manifest(),
      instructions: "# Weather\nForecast.",
      expectedRevision: 0,
    });
    await privateRepo.repo.submitForPublish({
      actor: owner,
      skillId: SKILL_ID,
      versionId: hidden.versionId,
      expectedRevision: 1,
    });
    await privateRepo.repo.publishApprovedRevision({
      actor: approver,
      skillId: SKILL_ID,
      expectedRevision: 1,
    });
    expect(await privateRepo.repo.getById(stranger, SKILL_ID)).toBeNull();
    await expect(
      privateRepo.repo.authorizeInvocation({
        actor: stranger,
        skillId: SKILL_ID,
      }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("rejects invocation when the actor lacks the requested capability", async () => {
    const store = new MemorySkillDefinitionStore();
    const repo = new PostgresSkillRepository(store, {
      policy: {
        authors: new Set(["123"]),
        approvers: new Set(["200"]),
        retirees: new Set(),
        capabilityGrants: new Map([["123", new Set()]]),
      },
    });
    await expect(
      repo.saveDraftRevision({
        actor: owner,
        manifest: manifest(),
        instructions: "# Weather\nForecast.",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("pins an older published version after a newer revision is published", async () => {
    const { repo } = repository();
    const first = await repo.saveDraftRevision({
      actor: owner,
      manifest: manifest({ tools: [] }),
      instructions: "# Weather v1",
      expectedRevision: 0,
    });
    await repo.submitForPublish({
      actor: owner,
      skillId: SKILL_ID,
      versionId: first.versionId,
      expectedRevision: 1,
    });
    await repo.publishApprovedRevision({
      actor: approver,
      skillId: SKILL_ID,
      expectedRevision: 1,
    });
    const second = await repo.saveDraftRevision({
      actor: owner,
      manifest: manifest({ tools: [], revision: 2 }),
      instructions: "# Weather v2",
      expectedRevision: 1,
    });
    await repo.submitForPublish({
      actor: owner,
      skillId: SKILL_ID,
      versionId: second.versionId,
      expectedRevision: 2,
    });
    await repo.publishApprovedRevision({
      actor: approver,
      skillId: SKILL_ID,
      expectedRevision: 2,
    });
    expect(await repo.getById(owner, SKILL_ID, first.versionId)).toMatchObject({
      versionId: first.versionId,
      instructions: "# Weather v1",
    });
    expect(await repo.getById(owner, SKILL_ID)).toMatchObject({
      versionId: second.versionId,
      instructions: "# Weather v2",
    });
  });

  it("returns a revision conflict without overwriting the stored version", async () => {
    const { repo, store } = repository();
    await repo.saveDraftRevision({
      actor: owner,
      manifest: manifest({ tools: [] }),
      instructions: "# Weather\nForecast.",
      expectedRevision: 0,
    });
    await expect(
      repo.saveDraftRevision({
        actor: owner,
        manifest: manifest({ tools: [], revision: 2 }),
        instructions: "# Weather\nOther.",
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(SkillRevisionConflictError);
    expect(store.versions).toHaveLength(1);
  });

  it("retires a skill so it cannot be discovered or executed", async () => {
    const { repo } = repository();
    const draft = await repo.saveDraftRevision({
      actor: owner,
      manifest: manifest({ tools: [] }),
      instructions: "# Weather\nForecast.",
      expectedRevision: 0,
    });
    await repo.submitForPublish({
      actor: owner,
      skillId: SKILL_ID,
      versionId: draft.versionId,
      expectedRevision: 1,
    });
    await repo.publishApprovedRevision({
      actor: approver,
      skillId: SKILL_ID,
      expectedRevision: 1,
    });
    await repo.retire({ actor: owner, skillId: SKILL_ID, expectedRevision: 1 });
    expect(await repo.listAvailableToTelegramUser(owner)).toEqual([]);
    expect(await repo.getById(owner, SKILL_ID, draft.versionId)).toBeNull();
  });

  it("rejects a malformed stored manifest", async () => {
    const store = new MemorySkillDefinitionStore();
    const versionId = randomUUID();
    store.skills.set(SKILL_ID, {
      id: SKILL_ID,
      name: "Weather",
      ownerTelegramUserId: "123",
      visibility: "public",
      status: "active",
      currentVersionId: versionId,
    });
    store.versions.push({
      id: versionId,
      skillId: SKILL_ID,
      revision: 1,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: {} as SkillManifest,
      instructions: "text",
      state: "published",
      createdBy: "123",
    });
    const repo = new PostgresSkillRepository(store);
    await expect(repo.getById(owner, SKILL_ID)).rejects.toThrow();
  });
});
