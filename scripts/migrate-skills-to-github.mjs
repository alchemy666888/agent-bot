#!/usr/bin/env node
/**
 * Operator-only, resumable PostgreSQL -> GitHub skill migration.
 *
 * Required: SKILL_MIGRATION_DATABASE_URL (a LOGIN role with rolcanlogin and no
 * write privileges), GITHUB_TOKEN. Target coordinates intentionally default to
 * alchemy666888/skill; secrets are never serialized or logged.
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { Pool } from "pg";
import { z } from "zod";

const OWNER = process.env.GITHUB_SKILLS_OWNER ?? "alchemy666888";
const REPO = process.env.GITHUB_SKILLS_REPO ?? "skill";
const BASE = process.env.GITHUB_SKILLS_BRANCH ?? "main";
const BRANCH =
  process.env.SKILL_MIGRATION_BRANCH ?? "migration/postgres-skills";
const STATE_PATH =
  process.env.SKILL_MIGRATION_STATE ?? ".skill-migration-state.json";
const REPORT_PATH =
  process.env.SKILL_MIGRATION_REPORT ?? "skill-migration-reconciliation.json";
const uuid = z.uuid();
const sha = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const sortedStrings = (values) => [...values].sort();
const sortedTriggers = (values) =>
  [...values].sort((a, b) =>
    `${a.type}\0${a.value}`.localeCompare(`${b.type}\0${b.value}`),
  );

const rowSchema = z.object({
  stable_id: z.string(),
  version_id: z.string(),
  draft_id: z.string(),
  draft_revision: z.coerce.number().int().positive(),
  version_number: z.coerce.number().int().positive(),
  status: z.enum(["active", "retired", "superseded"]),
  display_name: z.string().min(1),
  description: z.string().nullable(),
  approved_body: z.string().min(1),
  approved_document: z.unknown(),
  approved_by: z.string().min(1),
  approved_at: z.union([z.date(), z.string()]),
  approval_source: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
  owners: z.array(z.string()),
  triggers: z.array(z.object({ type: z.string(), value: z.string() })),
  tools: z.array(z.string()),
  capabilities: z.array(z.string()),
});

const SQL = `SELECT s.id::text stable_id, s.display_name, v.id::text version_id,
 v.draft_id::text, v.draft_revision, v.version_number, v.status, v.description,
 v.approved_body, v.approved_document, v.approved_by, v.approved_at,
 v.approval_source, v.created_at, v.updated_at,
 COALESCE((SELECT jsonb_agg(o.telegram_user_id ORDER BY o.telegram_user_id) FROM skill_owners o WHERE o.version_id=v.id),'[]') owners,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('type',t.trigger_type,'value',t.trigger_value) ORDER BY t.trigger_type,t.trigger_value) FROM skill_triggers t WHERE t.version_id=v.id),'[]') triggers,
 COALESCE((SELECT jsonb_agg(x.tool_name ORDER BY x.tool_name) FROM skill_tools x WHERE x.version_id=v.id),'[]') tools,
 COALESCE((SELECT jsonb_agg(c.capability ORDER BY c.capability) FROM skill_capabilities c WHERE c.version_id=v.id),'[]') capabilities
 FROM skills s JOIN skill_versions v ON v.skill_id=s.id
 ORDER BY s.id, v.version_number, v.id`;

function iso(value) {
  return new Date(value).toISOString();
}
function assertUnique(values, label) {
  if (new Set(values).size !== values.length)
    throw new Error(`MALFORMED_ROW:${label}`);
  return values;
}

export function convertRow(input) {
  const row = rowSchema.parse(input);
  uuid.parse(row.stable_id);
  uuid.parse(row.version_id);
  uuid.parse(row.draft_id);
  const doc = z
    .object({
      stableId: z.string(),
      draftId: z.string(),
      revision: z.number(),
      name: z.string(),
      body: z.string(),
      ownerTelegramUserIds: z.array(z.string()),
      triggers: z.array(z.object({ type: z.string(), value: z.string() })),
      tools: z.array(z.string()),
      capabilities: z.array(z.string()),
      approval: z.object({
        approvedBy: z.string(),
        approvedAt: z.string(),
        source: z.string().optional(),
      }),
    })
    .passthrough()
    .parse(row.approved_document);
  if (
    doc.stableId !== row.stable_id ||
    doc.draftId !== row.draft_id ||
    doc.revision !== row.draft_revision ||
    doc.body !== row.approved_body ||
    doc.name !== row.display_name ||
    canonical(sortedStrings(doc.ownerTelegramUserIds)) !==
      canonical(sortedStrings(row.owners)) ||
    canonical(sortedTriggers(doc.triggers)) !==
      canonical(sortedTriggers(row.triggers)) ||
    canonical(sortedStrings(doc.tools)) !==
      canonical(sortedStrings(row.tools)) ||
    canonical(sortedStrings(doc.capabilities)) !==
      canonical(sortedStrings(row.capabilities)) ||
    doc.approval.approvedBy !== row.approved_by ||
    iso(doc.approval.approvedAt) !== iso(row.approved_at) ||
    (doc.approval.source ?? null) !== row.approval_source
  )
    throw new Error(
      `MALFORMED_ROW:approved_document_mismatch:${row.version_id}`,
    );
  const owners = assertUnique(row.owners, "owners");
  if (!owners.length || owners.some((x) => !/^\d+$/.test(x)))
    throw new Error(`MALFORMED_ROW:owners:${row.version_id}`);
  const triggers = row.triggers.map((t) => ({
    type: z.enum(["command", "keyword", "event"]).parse(t.type),
    value: z.string().min(1).parse(t.value),
  }));
  const digest = sha(row.approved_body);
  const manifest = {
    schemaVersion: 1,
    id: row.stable_id,
    name: row.display_name,
    ...(row.description === null ? {} : { description: row.description }),
    revision: row.version_number,
    visibility: "private",
    ownerTelegramUserIds: owners,
    allowedTelegramUserIds: [],
    triggers: {
      phrases: triggers.filter((t) => t.type !== "keyword").map((t) => t.value),
      keywords: triggers
        .filter((t) => t.type === "keyword")
        .map((t) => t.value),
      minimumConfidence: 1,
    },
    tools: assertUnique(row.tools, "tools"),
    prohibitedActions: [],
    status: row.status === "active" ? "active" : "retired",
    migration: {
      sourceVersionId: row.version_id,
      sourceVersionNumber: row.version_number,
      sourceStatus: row.status,
      sourceContentDigest: digest,
      sourceTriggers: triggers,
      capabilities: assertUnique(row.capabilities, "capabilities"),
      approval: {
        approvedBy: row.approved_by,
        approvedAt: iso(row.approved_at),
        ...(row.approval_source ? { source: row.approval_source } : {}),
      },
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
  };
  return { row, manifest, body: row.approved_body, digest };
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      return { schemaVersion: 1, branch: BRANCH, versions: {} };
    throw e;
  }
}
async function saveJson(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function github(token) {
  const call = async (path, init = {}) => {
    const r = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}${path}`,
      {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...init.headers,
        },
      },
    );
    if (!r.ok) throw new Error(`GITHUB_${r.status}:${path.split("?")[0]}`);
    return r.status === 204 ? null : r.json();
  };
  return {
    call,
    async ref(name) {
      return (await call(`/git/ref/heads/${encodeURIComponent(name)}`)).object
        .sha;
    },
    async commit(id) {
      return call(`/git/commits/${id}`);
    },
    async blob(content) {
      return (
        await call("/git/blobs", {
          method: "POST",
          body: JSON.stringify({ content, encoding: "utf-8" }),
        })
      ).sha;
    },
    async tree(base_tree, entries) {
      return (
        await call("/git/trees", {
          method: "POST",
          body: JSON.stringify({ base_tree, tree: entries }),
        })
      ).sha;
    },
    async createCommit(message, tree, parent) {
      return (
        await call("/git/commits", {
          method: "POST",
          body: JSON.stringify({ message, tree, parents: [parent] }),
        })
      ).sha;
    },
    async updateRef(value) {
      await call(`/git/refs/heads/${encodeURIComponent(BRANCH)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: value, force: false }),
      });
    },
    async createRef(value) {
      await call("/git/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: value }),
      });
    },
    async file(path, ref) {
      return call(
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
    },
  };
}

async function main() {
  const databaseUrl = process.env.SKILL_MIGRATION_DATABASE_URL;
  const token = process.env.GITHUB_TOKEN;
  if (!databaseUrl || !token)
    throw new Error("Required operator credentials are not configured");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  let raw;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const role = await client.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user",
    );
    const r = role.rows[0];
    if (!r?.rolcanlogin || r.rolsuper || r.rolcreatedb || r.rolcreaterole)
      throw new Error("DATABASE_ROLE_NOT_READ_ONLY");
    raw = (await client.query(SQL)).rows;
    await client.query("COMMIT");
  } finally {
    client.release();
    await pool.end();
  }
  const converted = raw.map(convertRow);
  const ids = new Set();
  for (const x of converted) {
    if (ids.has(x.row.version_id))
      throw new Error(`DUPLICATE_SOURCE_VERSION:${x.row.version_id}`);
    ids.add(x.row.version_id);
  }
  const state = await loadState();
  if (state.branch !== BRANCH) throw new Error("STATE_BRANCH_MISMATCH");
  const api = github(token);
  let head;
  try {
    head = await api.ref(BRANCH);
  } catch (error) {
    if (
      Object.keys(state.versions).length ||
      !(error instanceof Error) ||
      !error.message.startsWith("GITHUB_404:")
    )
      throw error;
    head = await api.ref(BASE);
    await api.createRef(head);
  }
  const catalog = {
    schemaVersion: 1,
    skills: [
      ...new Map(
        converted.map((x) => [
          x.row.stable_id,
          { id: x.row.stable_id, directory: x.row.stable_id },
        ]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const pointerBySkill = new Map();
  for (const item of converted) {
    const current = pointerBySkill.get(item.row.stable_id);
    if (!current || item.row.status === "active")
      pointerBySkill.set(item.row.stable_id, item);
  }
  for (const item of converted) {
    const prior = state.versions[item.row.version_id];
    if (prior) {
      const remote = await api.commit(prior.commitSha);
      if (prior.contentDigest !== item.digest || !remote)
        throw new Error(`STATE_MISMATCH:${item.row.version_id}`);
      continue;
    }
    const directory = `skills/${item.row.stable_id}`,
      archive = `${directory}/versions/${item.row.version_number}-${item.row.version_id}`;
    try {
      const existing = await api.file(`${archive}/manifest.json`, head);
      const manifest = JSON.parse(
        Buffer.from(existing.content, "base64").toString("utf8"),
      );
      if (manifest.migration?.sourceContentDigest !== item.digest)
        throw new Error(`REMOTE_IDEMPOTENCY_CONFLICT:${item.row.version_id}`);
      state.versions[item.row.version_id] = {
        commitSha: head,
        contentDigest: item.digest,
        stableId: item.row.stable_id,
        versionNumber: item.row.version_number,
      };
      await saveJson(STATE_PATH, state);
      continue;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("REMOTE_IDEMPOTENCY_CONFLICT")
      )
        throw error;
      if (!(error instanceof Error) || !error.message.startsWith("GITHUB_404:"))
        throw error;
    }
    const manifest = `${JSON.stringify(item.manifest, null, 2)}\n`;
    const [mb, body, indexBlob] = await Promise.all([
      api.blob(manifest),
      api.blob(item.body),
      api.blob(`${JSON.stringify(catalog, null, 2)}\n`),
    ]);
    const paths = [`${archive}/manifest.json`, `${archive}/SKILL.md`];
    if (pointerBySkill.get(item.row.stable_id) === item)
      paths.push(`${directory}/manifest.json`, `${directory}/SKILL.md`);
    const tree = await api.tree(head, [
      ...paths.map((path) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: path.endsWith("SKILL.md") ? body : mb,
      })),
      {
        path: "skills/index.json",
        mode: "100644",
        type: "blob",
        sha: indexBlob,
      },
    ]);
    const commitSha = await api.createCommit(
      `Migrate skill version ${item.row.version_id}`,
      tree,
      head,
    );
    await api.updateRef(commitSha);
    head = commitSha;
    state.versions[item.row.version_id] = {
      commitSha,
      contentDigest: item.digest,
      stableId: item.row.stable_id,
      versionNumber: item.row.version_number,
    };
    await saveJson(STATE_PATH, state);
  }
  const unresolved = [];
  for (const item of converted) {
    const mapped = state.versions[item.row.version_id];
    if (!mapped) {
      unresolved.push({
        sourceVersionId: item.row.version_id,
        reason: "missing_commit",
      });
      continue;
    }
    const archive = `skills/${item.row.stable_id}/versions/${item.row.version_number}-${item.row.version_id}`;
    try {
      const [manifestFile, bodyFile] = await Promise.all([
        api.file(`${archive}/manifest.json`, head),
        api.file(`${archive}/SKILL.md`, head),
      ]);
      const target = JSON.parse(
        Buffer.from(manifestFile.content, "base64").toString("utf8"),
      );
      const targetBody = Buffer.from(bodyFile.content, "base64").toString(
        "utf8",
      );
      if (
        target.migration?.sourceContentDigest !== item.digest ||
        sha(targetBody) !== item.digest
      )
        unresolved.push({
          sourceVersionId: item.row.version_id,
          reason: "content_mismatch",
        });
      if (
        canonical(target.ownerTelegramUserIds) !== canonical(item.row.owners) ||
        canonical(target.migration?.capabilities) !==
          canonical(item.row.capabilities)
      )
        unresolved.push({
          sourceVersionId: item.row.version_id,
          reason: "owner_capability_mismatch",
        });
    } catch {
      unresolved.push({
        sourceVersionId: item.row.version_id,
        reason: "archive_unreadable",
      });
    }
  }
  for (const [stableId, expected] of pointerBySkill) {
    try {
      const [manifestFile, bodyFile] = await Promise.all([
        api.file(`skills/${stableId}/manifest.json`, head),
        api.file(`skills/${stableId}/SKILL.md`, head),
      ]);
      const target = JSON.parse(
        Buffer.from(manifestFile.content, "base64").toString("utf8"),
      );
      const body = Buffer.from(bodyFile.content, "base64").toString("utf8");
      if (
        target.migration?.sourceVersionId !== expected.row.version_id ||
        sha(body) !== expected.digest ||
        target.status !==
          (expected.row.status === "active" ? "active" : "retired")
      )
        unresolved.push({ stableId, reason: "current_pointer_mismatch" });
    } catch {
      unresolved.push({ stableId, reason: "current_pointer_unreadable" });
    }
  }
  const current = [...converted].filter((x) => x.row.status === "active");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceVersionCount: converted.length,
    mappedCommitCount: Object.keys(state.versions).filter((x) => ids.has(x))
      .length,
    activeVersionCount: current.length,
    sourceSetHash: sha(
      converted
        .map((x) => `${x.row.version_id}:${x.digest}`)
        .sort()
        .join("\n"),
    ),
    ownerCapabilityHash: sha(
      canonical(
        converted.map((x) => ({
          id: x.row.version_id,
          owners: x.row.owners,
          capabilities: x.row.capabilities,
        })),
      ),
    ),
    unresolved,
  };
  await saveJson(REPORT_PATH, report);
  if (unresolved.length) throw new Error("RECONCILIATION_FAILED");
  const existing = await api.call(
    `/pulls?state=all&head=${encodeURIComponent(`${OWNER}:${BRANCH}`)}&base=${encodeURIComponent(BASE)}`,
  );
  const pr =
    existing[0] ??
    (await api.call("/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: "Migrate PostgreSQL skills to GitHub",
        head: BRANCH,
        base: BASE,
        body: "Operator review required. Do not merge until the reconciliation report has no unresolved differences. Database cleanup is separately gated after merge and successful production GitHub reads.",
      }),
    }));
  console.log(
    JSON.stringify({
      branch: BRANCH,
      head,
      pullRequestNumber: pr.number,
      report: REPORT_PATH,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  });
