import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresPromptRepository } from "../../../src/server/prompts/postgres";

const connectionString = process.env.PROMPT_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("prompt confirmation concurrency", () => {
  const schema = `prompt_concurrency_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  const id = randomUUID();
  const token = "d".repeat(64);

  beforeAll(async () => {
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    await pool.query(
      await readFile("migrations/20261002_prompt_persistence.sql", "utf8"),
    );
    await pool.query(
      `INSERT INTO prompt_change_requests
       (id,actor_key,target_key,operation,scope,kind,prompt_id,sanitized_summary,proposal_digest,
        base_commit_sha,expires_at,confirmation_token_digest,confirmation_nonce,
        state,first_confirmed_at)
       VALUES ($1,'actor_abcdefghijklmnopqrstuv','target','delete','global','request','default',
        'delete default',$2,$3,now()+interval '10 min',$4,'nonce_abcdefghijklmnop','first_confirmed',now())`,
      [id, "a".repeat(64), "b".repeat(40), token],
    );
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it("allows duplicate webhook delivery to claim exactly one write", async () => {
    const repository = new PostgresPromptRepository(pool);
    const outcomes = await Promise.allSettled([
      repository.confirmSecondAndBeginCommit(id, token),
      repository.confirmSecondAndBeginCommit(id, token),
    ]);
    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT state FROM prompt_change_requests WHERE id=$1",
          [id],
        )
      ).rows[0].state,
    ).toBe("committing");
  });
});
