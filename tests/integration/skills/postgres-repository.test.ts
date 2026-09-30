import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSkillRepository } from "../../../src/worker/skills/postgres-repository";
import type { ApprovedSkillDraft } from "../../../src/worker/skills/schemas";

const connectionString = process.env.TEST_DATABASE_URL;
const liveDescribe = connectionString ? describe : describe.skip;
const schema = `skill_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;
let repository: PostgresSkillRepository;

function draft(
  overrides: Partial<ApprovedSkillDraft> = {},
): ApprovedSkillDraft {
  return {
    stableId: randomUUID(),
    draftId: randomUUID(),
    revision: 1,
    name: `Weather ${randomUUID().slice(0, 6)}`,
    description: "An approved weather skill",
    body: "# Weather\nOnly use declared tools.",
    ownerTelegramUserIds: ["12345"],
    triggers: [{ type: "command", value: "/weather" }],
    tools: ["weather.lookup"],
    capabilities: ["location-read"],
    approval: {
      approvedBy: "reviewer@example.test",
      approvedAt: "2026-09-30T00:00:00.000Z",
      source: "approval-queue",
    },
    ...overrides,
  };
}

liveDescribe("PostgresSkillRepository", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 5 });
    repository = new PostgresSkillRepository(pool);
    await repository.initialize();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("installs once and treats duplicate and concurrent approvals idempotently", async () => {
    const approved = draft();
    const first = await repository.installApprovedDraft(approved);
    const duplicate = await repository.installApprovedDraft(approved);
    expect(duplicate.versionId).toBe(first.versionId);

    const concurrent = draft();
    const installs = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.installApprovedDraft(concurrent),
      ),
    );
    expect(new Set(installs.map(({ versionId }) => versionId))).toEqual(
      new Set([installs[0]!.versionId]),
    );
  });

  it("versions, looks up, lists and limits skills by ownership", async () => {
    const stableId = randomUUID();
    const first = await repository.installApprovedDraft(
      draft({ stableId, ownerTelegramUserIds: ["777"] }),
    );
    const secondDraft = draft({
      stableId,
      revision: 2,
      name: "  Shared Skill  ",
      ownerTelegramUserIds: ["888"],
    });
    const second = await repository.installApprovedDraft(secondDraft);
    expect((await repository.supersedeVersion(first.versionId))?.status).toBe(
      "superseded",
    );
    expect((await repository.getById(stableId))?.versionId).toBe(
      second.versionId,
    );
    expect((await repository.getByName("SHARED SKILL"))?.stableId).toBe(
      stableId,
    );
    expect(
      await repository.listAvailableToTelegramUser("777"),
    ).not.toContainEqual(expect.objectContaining({ stableId }));
    expect(await repository.listAvailableToTelegramUser("888")).toContainEqual(
      expect.objectContaining({ stableId }),
    );
    expect(await repository.listInstalled()).toContainEqual(
      expect.objectContaining({ versionId: second.versionId }),
    );
    expect((await repository.retireVersion(second.versionId))?.status).toBe(
      "retired",
    );
  });

  it("rejects invalid input and invalid stored documents", async () => {
    await expect(
      repository.installApprovedDraft(draft({ body: "" })),
    ).rejects.toThrow();
    const installed = await repository.installApprovedDraft(draft());
    await pool.query(
      "ALTER TABLE skill_versions DISABLE TRIGGER skill_versions_immutable_approval",
    );
    await pool.query(
      "UPDATE skill_versions SET approved_document='{}'::jsonb WHERE id=$1",
      [installed.versionId],
    );
    await pool.query(
      "ALTER TABLE skill_versions ENABLE TRIGGER skill_versions_immutable_approval",
    );
    await expect(repository.getById(installed.stableId)).rejects.toThrow();
  });

  it("rolls back a failed transaction and records a retryable failure", async () => {
    await pool.query(`CREATE FUNCTION ${schema}.reject_owner() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_owner BEFORE INSERT ON skill_owners
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_owner()`);
    const approved = draft();
    await expect(repository.installApprovedDraft(approved)).rejects.toThrow();
    expect(await repository.getById(approved.stableId)).toBeNull();
    const failure = await pool.query(
      "SELECT retryable FROM skill_installation_failures WHERE draft_id=$1 AND draft_revision=$2",
      [approved.draftId, approved.revision],
    );
    expect(failure.rows).toEqual([{ retryable: true }]);
    await pool.query("DROP TRIGGER reject_owner ON skill_owners");
  });
});
