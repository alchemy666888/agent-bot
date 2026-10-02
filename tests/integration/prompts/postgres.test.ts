import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresPromptRepository } from "../../../src/server/prompts/postgres";

const connectionString = process.env.PROMPT_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("prompt PostgreSQL persistence", () => {
  const schema = `prompt_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });

  beforeAll(async () => {
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    await pool.query(
      await readFile("migrations/20261002_prompt_persistence.sql", "utf8"),
    );
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it("enforces one live actor/target request and terminal immutability", async () => {
    const insert = (id: string) =>
      pool.query(
        `INSERT INTO prompt_change_requests
          (id,actor_key,target_key,operation,scope,kind,prompt_id,sanitized_summary,
           encrypted_proposed_content,proposal_digest,base_commit_sha,expires_at,
           confirmation_token_digest,confirmation_nonce)
         VALUES ($1,$2,$3,'update','global','request','default','safe summary',$4,$5,$6,now()+interval '10 min',$7,$8)`,
        [
          id,
          "actor_abcdefghijklmnopqrstuv",
          "global:request:default",
          Buffer.from("ciphertext"),
          "a".repeat(64),
          "b".repeat(40),
          "c".repeat(64),
          "nonce_abcdefghijklmnop",
        ],
      );
    const id = randomUUID();
    await insert(id);
    await expect(insert(randomUUID())).rejects.toMatchObject({ code: "23505" });

    const repository = new PostgresPromptRepository(pool);
    await repository.confirmFirst(id, "c".repeat(64));
    await repository.confirmSecondAndBeginCommit(id, "c".repeat(64));
    await repository.markVerified(id);
    await expect(repository.markFailed(id, "WRITE_FAILED")).rejects.toThrow();
  });

  it("activates exactly one complete verified snapshot", async () => {
    const repository = new PostgresPromptRepository(pool);
    const identity = { owner: "owner", name: "repo", prefix: "prompts" };
    await repository.activateSnapshot({
      ...identity,
      commitSha: "1".repeat(40),
      payload: { files: ["a"] },
      contentDigest: "2".repeat(64),
      validatedAt: new Date(),
    });
    await repository.activateSnapshot({
      ...identity,
      commitSha: "3".repeat(40),
      payload: { files: ["b"] },
      contentDigest: "4".repeat(64),
      validatedAt: new Date(),
    });
    const result = await pool.query(
      "SELECT commit_sha, snapshot_payload FROM prompt_snapshots WHERE active",
    );
    expect(result.rows).toEqual([
      { commit_sha: "3".repeat(40), snapshot_payload: { files: ["b"] } },
    ]);
  });
});
