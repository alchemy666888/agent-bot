# Deployment

## Worker release artifact

`src/worker/cli.ts` is the sole worker entry point. `dist/worker.mjs` is a
generated-only release artifact and remains ignored by Git; a clean checkout
creates it with `pnpm worker:build`. The build uses fixed esbuild options and
`pnpm worker:verify` rebuilds into a temporary directory, byte-compares the
result, and rejects prohibited server-only configuration names and any known
secret values supplied to verification. This catches missing or stale prompt
modules without embedding environment-derived prompt content. Only the minimal
compiled emergency request/runtime policy remains available in worker source;
normal common, personal, and request prompts arrive in the validated v2 bundle.

`pnpm build` always builds and verifies the worker before Next.js packaging.
CI must use that command (or run `pnpm worker:build && pnpm worker:verify`
explicitly) and must not cache or download `dist/worker.mjs` from another
revision. Next.js output tracing includes `./dist/worker.mjs`, the exact path
read by the Telegram dispatcher. Deploy server and worker contract changes
together; never pair a server requiring v2 bundles with an older worker unless
tested version negotiation has been introduced.

PostgreSQL remains the durable store for conversations, messages, updates, logs, and other application/operational state. GitHub is the durable source for skill definitions. A Vercel Sandbox is a disposable execution boundary; never deploy a configuration that treats its filesystem as a backup.

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

`@vercel/connect` obtains its workload identity from `VERCEL_OIDC_TOKEN` when the Next.js server loads a skill catalog. The server resolves the configured branch once, validates every manifest and skill document at that immutable commit, and passes a schema-validated snapshot to the Sandbox worker. The snapshot is capped at 4 MiB. GitHub credentials and connector configuration are never forwarded to the worker, written to request/response files, included in prompts, or persisted in application data.

### Prompt repository rollout

Use a dedicated prompt connector rather than the skill-authoring connector. Install it on the private prompt repository only, with **Metadata: Read-only** and **Contents: Read and write**. Grant no Pull requests, Administration, Checks, Secrets, Webhooks, organization, or account permissions. Prompt changes commit only after application confirmation and compare-and-set validation; adding PR permission is outside this rollout.

Preview and Production use separate connector installations and separately scoped Vercel configuration. Preview uses a disposable private repository unless an operator explicitly approves read access to Production's repository. Deploy the expand migration first with every control false and cohort zero:

```dotenv
PROMPT_READS_ENABLED=false
PROMPT_PERSONAL_READS_ENABLED=false
PROMPT_OPERATOR_WRITES_ENABLED=false
PROMPT_PERSONAL_WRITES_ENABLED=false
PROMPT_AUTONOMOUS_SUGGESTIONS_ENABLED=false
PROMPT_SUGGESTION_COHORT_PERCENT=0
PROMPT_ROUTER_ENABLED=false
GITHUB_CONNECTOR=github/prompts-production
GITHUB_PROMPTS_OWNER=<private-owner>
GITHUB_PROMPTS_REPO=<private-prompt-repository>
GITHUB_PROMPTS_BRANCH=main
GITHUB_PROMPTS_PREFIX=prompts
PROMPT_OPERATOR_TELEGRAM_IDS=123456789,987654321
PROMPT_USER_KEY_SECRET=<independent-secret-of-at-least-32-characters-and-eight-distinct-characters>
PROMPT_CACHE_TTL_SECONDS=300
PROMPT_CONFIRMATION_TTL_SECONDS=600
PROMPT_ROUTER_CONFIDENCE_THRESHOLD=0.75
```

These controls are server-only and never browser variables or worker environment values. The operator allowlist accepts canonical positive numeric Telegram IDs only. Rotating the user-key secret creates a new `u1_` namespace and requires an audited namespace migration or intentional reset.

## Ordered prompt rollout

Every stage uses the same tested artifact and a recorded deployment. Stopping a stage means leaving its flag false (or returning it to false) and redeploying; a stop itself performs no database or GitHub mutation.

1. Apply `20261002_prompt_persistence.sql` with all controls false. Record its version/checksum and verify application-role grants.
2. Seed the v1 schema, `prompts/common/system/base.md`, and `prompts/global/requests/default.md` on protected `main`. A second operator independently validates schema, content, exact blob digests, default resolution, and the commit; record that commit before use.
3. Run read-only shadow refresh and validation out of band. It may resolve and validate but cannot serve content, create change requests, or write GitHub. Require freshness within five minutes and zero validation/authentication failures.
4. Set `PROMPT_READS_ENABLED=true`, leaving personal reads and router false, to serve verified common/default layers.
5. Set `PROMPT_PERSONAL_READS_ENABLED=true`; verify two opaque users and cross-user non-discovery.
6. Set `PROMPT_OPERATOR_WRITES_ENABLED=true` for operator global/common changes. In a separate deployment set `PROMPT_PERSONAL_WRITES_ENABLED=true` for explicit, two-confirmation personal changes. Neither authorizes autonomous proposals.
7. Set `PROMPT_ROUTER_ENABLED=true` only after shadow routing passes. Then enable `PROMPT_AUTONOMOUS_SUGGESTIONS_ENABLED=true` with `PROMPT_SUGGESTION_COHORT_PERCENT=1` (or an approved small value). Allocation is deterministic SHA-256 bucketing of the opaque user key; raw identity is never used or logged.
8. After the recorded observation window meets all thresholds, increase the cohort in separately stoppable deployments, finally to 100.

Preview completes each stage first with Preview-only credentials/configuration. Production values must not be copied into Preview. There is no web administration interface; flags change only through the audited deployment environment.

## DeepSeek routing rollout

Routing is off by default. Deploy the same artifact with
`DEEPSEEK_ROUTING_ENABLED=true` and `DEEPSEEK_ROUTING_MODE=shadow` first. In
shadow mode the worker obtains and validates a bounded classifier decision,
but the established skill resolver/capability route remains authoritative; a
shadow-selected skill or tool is never executed. Compare safe routing records
for at least one representative peak window.

Promotion to `DEEPSEEK_ROUTING_MODE=enforced` requires named operator approval
and evidence that authorization tests pass, p95 added latency and cost remain
within the thresholds in `docs/operations.md`, fallback and invalid-response
rates are acceptable, and no internal protocol leaks reach Telegram. Configure
the 250–30000 ms timeout and optional 0–1 minimum confidence before promotion;
the server and worker reject out-of-range settings. Canary enforced routing
with non-effectful capabilities before widening traffic.

The transition used a temporary server-only `SKILL_STORE` selector with
`postgres` as its initial default, `github-shadow` for comparison, and `github`
for cutover. It was never sent to the browser or Sandbox. That selector and the
PostgreSQL skill-definition repository have now been removed: current releases
always read definitions from GitHub. The sequence below documents the required
deployment history and must not be recreated by adding a client-visible flag.

1. Disable or leave disabled Telegram delivery and set `SKILLS_ENABLED=false`; disable effectful capability registry entries.
2. Create a provider-consistent backup and record its ID, schema version, UTC time, and encryption/retention location.
3. On the historical transition release, deploy `postgres`, run the resumable operator migration, and require an aggregate reconciliation report with zero mismatches across IDs, owners, status, capabilities, and content digests.
4. Deploy `github-shadow` to Preview. Keep PostgreSQL authoritative; load GitHub out of band and emit only aggregate safe reason/count metrics. Exercise the entire two-user workflow in `docs/acceptance-evidence.md`.
5. Merge the migration PR after review, deploy Preview GitHub reads pinned to the merged commit, invalidate old process caches by redeploying, and repeat the workflow against the protected default branch.
6. Switch Production reads to `github` by changing only the server environment and deploying the same artifact. Do not write back, dual-write, or copy deltas during cutover. Keep legacy definition tables read-only and retain the named pre-cutover backup for the operator-defined observation window.
7. During that window, monitor GitHub authentication/validation failures, rate-limit headroom, stale-cache use, authorization denials, latency, and invocation results. Roll back using the selector and a deployment; never copy a partially migrated catalog during an incident.
8. After the recorded observation window and approvals, attest the merged commit and zero-mismatch reconciliation as described in `migrations/README.md`, apply `20261001_drop_legacy_skill_definition_tables.sql`, and deploy this post-transition release, which contains no selector or PostgreSQL definition repository.
9. Check `/api/health`, run the automated suites and isolated restore rehearsal, enable approved registry entries, set `SKILLS_ENABLED=true`, perform one low-risk canary invocation, and register/re-enable the Telegram webhook last.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test:unit && pnpm test:integration && pnpm test:contracts && pnpm test:e2e
pnpm test -- tests/acceptance/skills
pnpm build
```

Installed skills are private per owner. Only migrations/operator administration may create `visibility=global` skills. A release must not introduce shared/team/public visibility without an approved schema and authorization change.
