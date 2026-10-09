#!/usr/bin/env node
/**
 * One-time import of active GitHub skill definitions into PostgreSQL.
 *
 * Reads the protected default branch, validates each manifest, and inserts a
 * published skill_versions row when that content digest is not already stored.
 * Re-running the script does not duplicate versions. It does not delete or
 * rewrite files in the GitHub repository.
 *
 * Required: GITHUB_TOKEN, DATABASE_URL.
 * Optional: GITHUB_SKILLS_OWNER, GITHUB_SKILLS_REPO, GITHUB_SKILLS_BRANCH,
 * GITHUB_SKILLS_PREFIX.
 */
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { Pool } from "pg";

const owner = process.env.GITHUB_SKILLS_OWNER ?? "alchemy666888";
const repo = process.env.GITHUB_SKILLS_REPO ?? "skill";
const branch = process.env.GITHUB_SKILLS_BRANCH ?? "main";
const prefix = (process.env.GITHUB_SKILLS_PREFIX ?? "skills").replace(
  /\/$/,
  "",
);
const token = process.env.GITHUB_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

if (!token || !databaseUrl) {
  console.error("GITHUB_TOKEN and DATABASE_URL are required");
  process.exit(1);
}

function digest(content) {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function githubFile(path) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "telegram-agent-skill-import",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  const body = await response.json();
  if (typeof body.content !== "string")
    throw new Error(`GitHub file ${path} has no content`);
  return Buffer.from(body.content, "base64").toString("utf8");
}

const pool = new Pool({ connectionString: databaseUrl });
const indexText = await githubFile(`${prefix}/index.json`);
if (!indexText) {
  console.log("No skill index found; nothing to import");
  await pool.end();
  process.exit(0);
}
const index = JSON.parse(indexText);
if (!Array.isArray(index.skills))
  throw new Error("Skill index is missing skills");

let imported = 0;
let skipped = 0;
for (const entry of index.skills) {
  const directory = String(entry.directory ?? "");
  if (directory.includes("..") || directory.startsWith("/"))
    throw new Error(`Unsafe skill directory for ${entry.id}`);
  const manifestText = await githubFile(`${prefix}/${directory}/manifest.json`);
  const instructions = await githubFile(`${prefix}/${directory}/SKILL.md`);
  if (!manifestText || !instructions) {
    console.error(`Skipping ${entry.id}: missing manifest or SKILL.md`);
    skipped += 1;
    continue;
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.id !== entry.id || manifest.status !== "active") {
    skipped += 1;
    continue;
  }
  const contentDigest = digest(instructions);
  const existing = await pool.query(
    `SELECT id FROM skill_versions
      WHERE skill_id = $1 AND content_digest = $2 AND state = 'published'`,
    [manifest.id, contentDigest],
  );
  if (existing.rows[0]) {
    skipped += 1;
    continue;
  }
  const versionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO skills (id, name, owner_telegram_user_id, visibility, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         visibility = EXCLUDED.visibility,
         status = 'active',
         updated_at = now()`,
      [
        manifest.id,
        manifest.name,
        manifest.ownerTelegramUserIds[0],
        manifest.visibility,
      ],
    );
    const latest = await client.query(
      `SELECT COALESCE(MAX(revision), 0)::int AS revision
         FROM skill_versions WHERE skill_id = $1`,
      [manifest.id],
    );
    const revision = Number(latest.rows[0].revision) + 1;
    await client.query(
      `INSERT INTO skill_versions
         (id, skill_id, revision, content_digest, manifest, instructions, state, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'published', $7)`,
      [
        versionId,
        manifest.id,
        revision,
        contentDigest,
        JSON.stringify({ ...manifest, revision }),
        instructions,
        manifest.ownerTelegramUserIds[0],
      ],
    );
    await client.query(
      `UPDATE skills SET current_version_id = $2, updated_at = now() WHERE id = $1`,
      [manifest.id, versionId],
    );
    await client.query(
      `INSERT INTO skill_audit_events (event_kind, actor_telegram_user_id, skill_id, version_id)
       VALUES ('skill.imported', $1, $2, $3)`,
      [manifest.ownerTelegramUserIds[0], manifest.id, versionId],
    );
    await client.query("COMMIT");
    imported += 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

console.log(`Imported ${imported} skill version(s); skipped ${skipped}`);
await pool.end();
