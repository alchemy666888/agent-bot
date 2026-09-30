# Deployment

PostgreSQL is the only durable store. A Vercel Sandbox is a disposable execution boundary and is hydrated from PostgreSQL; never deploy a configuration that treats its filesystem as a backup.

## Database and roles

Provision separate Preview and Production databases reachable from the Sandbox over IPv4/TLS. Preserve provider SSL parameters; for Aiven, set the complete PEM in `AIVEN_PG_CA`. Create separate roles:

- the **migrator** (`DATABASE_MIGRATOR_URL`) may create/alter schema and registry control-plane records;
- the **application** (`DATABASE_URL`) has only required DML/sequence access and cannot alter schema, mutate immutable versions/audit history, or register capabilities;
- the **backup/restore operator** is held outside the application and follows provider least privilege.

Do not make `DATABASE_MIGRATOR_URL` available to the running Next.js or Sandbox application. Production startup checks `schema_migrations` compatibility/checksums and fails closed; it does not create tables.

## GitHub Connect

Run these commands from a directory linked to the Vercel project. The connector UID produced by `create` is `github/<name>`, so the example matches `GITHUB_CONNECTOR=github/skills-repo`:

```bash
vercel connect create github --name skills-repo
vercel connect attach github/skills-repo --project <vercel-project> --environment production --environment preview --yes
```

The second command is the environment attachment: it permits only Production and Preview deployments of `<vercel-project>` to exchange their Vercel workload identity for a connector token. Do not attach Development unless local Connect access is explicitly required. Set the following separately in the Vercel project's **Preview** and **Production** environment-variable scopes (the values are configuration, not GitHub credentials):

```dotenv
GITHUB_CONNECTOR=github/skills-repo
GITHUB_SKILLS_OWNER=alchemy666888
GITHUB_SKILLS_REPO=skill
GITHUB_SKILLS_BRANCH=main
GITHUB_SKILLS_PREFIX=skills
```

For stronger isolation, use a separate GitHub App connection for each environment. Install both on the same selected repository only if Preview must exercise the production repository; otherwise use a disposable Preview repository:

```bash
vercel connect create github --name skills-repo-production
vercel connect attach github/skills-repo-production --project <vercel-project> --environment production --yes

vercel connect create github --name skills-repo-preview
vercel connect attach github/skills-repo-preview --project <vercel-project> --environment preview --yes
```

In that layout set `GITHUB_CONNECTOR=github/skills-repo-production` in Production and `GITHUB_CONNECTOR=github/skills-repo-preview` in Preview, with the matching owner, repository, branch, and optional prefix in each scope.

Each `create` flow opens or provides the GitHub App installation flow. On GitHub:

1. Choose the intended organization or user account.
2. Select **Only select repositories**, then select only `alchemy666888/skill` (or the dedicated Preview repository). Never select **All repositories**.
3. Grant the minimum repository permissions needed by the skill Git workflow: **Metadata: Read-only** (GitHub requires it), **Contents: Read and write** for reading definitions and creating branches/commits, and **Pull requests: Read and write** for opening and updating review PRs. Leave Administration, Actions, Checks, Deployments, Issues, Members, Secrets, Webhooks, and every organization/account permission at **No access**. If a deployment only reads immutable skills and never authors them, reduce Contents to **Read-only** and omit Pull requests.
4. Complete the installation, return to Vercel, and verify it with `vercel connect list`. Re-run `vercel connect attach` only for the environments that should use that installation.

`@vercel/connect` obtains its workload identity from `VERCEL_OIDC_TOKEN` when `getToken()` executes. At present this repository has **no `getToken()` call** in either the Next.js server or Sandbox worker. Consequently the OIDC token is consumed only implicitly by Vercel's server-side SDKs and is not forwarded by `invokeWorker`: worker request JSON contains only the validated operation payload, while operation environment values use the Sandbox SDK's command `env` mechanism. When GitHub access is implemented, prefer calling `getToken(readGitHubConfig().GITHUB_CONNECTOR)` in the Next.js server. If it must execute in the worker, pass only `VERCEL_OIDC_TOKEN` and the five validated `GITHUB_*` values in that operation's command environment; never add them to request/response files, prompts, logs, database records, snapshots, or persisted state.

## Ordered rollout

1. Disable or leave disabled Telegram delivery and set `SKILLS_ENABLED=false`; disable effectful capability registry entries.
2. Create a provider-consistent backup and record its ID, schema version, UTC time, and encryption/retention location.
3. Run `DATABASE_URL="$DATABASE_MIGRATOR_URL" pnpm migrate` from the trusted deployment job. Apply expand/migrate/contract migrations only after old code compatibility is proven.
4. Run the migration acceptance suite against an empty database and an upgraded copy: `pnpm test -- tests/acceptance/skills/migration-restore.test.ts`.
5. Deploy with `pnpm build`. Configure all `.env.example` values; keep capability credentials server-side and adapter-scoped.
6. Check `/api/health` for schema compatibility, then exercise create → clarify → revise → approve → install → list → discover → select with capability execution still disabled.
7. Verify a second user cannot find/select the private skill. Verify an unregistered/ungranted capability is denied and audited before dispatch.
8. Run all acceptance suites and an isolated backup restoration. Link outputs/correlation IDs in `docs/acceptance-evidence.md`.
9. After operator sign-off, enable approved registry entries, set `SKILLS_ENABLED=true`, redeploy, perform one low-risk canary execution, and register/re-enable the Telegram webhook last.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test:unit && pnpm test:integration && pnpm test:contracts && pnpm test:e2e
pnpm test -- tests/acceptance/skills
pnpm build
```

Installed skills are private per owner. Only migrations/operator administration may create `visibility=global` skills. A release must not introduce shared/team/public visibility without an approved schema and authorization change.
