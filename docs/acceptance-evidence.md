# Acceptance evidence

This file is the release evidence index, not evidence by assertion. Do not mark a
live gate complete without attaching the immutable deployment ID, UTC interval,
redacted command output or dashboard query, correlation IDs, and two operator
approvals. Never paste Telegram IDs, connector tokens, repository paths, skill
content, or database rows here.

## Local implementation evidence

Record the commit SHA and CI URL for `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test`, and `pnpm build`. The migration unit test must
show that provenance is preserved and malformed source documents fail closed.
The repository integration and security-contract suites must cover immutable
reads, authorization, concurrency conflicts, rate limits, and stale-cache
bounds.

## Live migration and rollout record

The following fields intentionally remain **UNRECORDED** until an operator runs
the procedure with real Preview/Production, PostgreSQL, GitHub, and Telegram
credentials. Local tests are not a substitute.

| Gate                    | Required redacted evidence                                                                                                                          | Status     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Pre-migration backup    | Backup ID, schema version, checksum, restore rehearsal ID                                                                                           | UNRECORDED |
| Copy and reconciliation | Migration PR, merged commit, report SHA-256, source/mapped/active counts, `mismatchMetrics.total=0`                                                 | UNRECORDED |
| Preview GitHub reads    | Preview deployment ID, resolved commit, health check, zero validation/auth failures                                                                 | UNRECORDED |
| Two-user workflow       | Correlation IDs proving authoring, revision, explicit approval, PR creation, operator merge, listing, selection, invocation, and cross-owner denial | UNRECORDED |
| Production cutover      | Production deployment ID/time, canary correlation ID, rate-limit/cache dashboards                                                                   | UNRECORDED |
| Observation window      | Explicit start/end UTC, rollback-window backup retention, incident/error totals, approvers                                                          | UNRECORDED |
| Contract cleanup        | Attestation row timestamp/commit, migration job ID, post-cleanup schema inventory                                                                   | UNRECORDED |
| Connector rotation      | Old/new connector IDs (not tokens), attachment scopes, validation deployment, old connector revocation time                                         | UNRECORDED |

For the two-user walkthrough, user A must create and revise a private skill,
approve the exact digest, observe PR creation, wait for an operator merge, list,
select, and invoke it. User B must be unable to discover, select, invoke, revise,
approve, retire, or infer that skill. Also prove that an unregistered or
ungranted capability is denied before dispatch. Record only correlation IDs and
safe result codes.

See `docs/deployment.md` for the ordered rollout, `docs/operations.md` for
monitoring and connector procedures, and `docs/rollback.md` for rollback rules.

## PH-013 prompt rollout record

Do not replace `UNRECORDED` with an assertion. Attach immutable redacted evidence; never record repository coordinates, identities, prompt content, or credentials.

| Gate                  | Required evidence                                                                                                                                                                | Status     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Expand deployment     | Deployment ID, `20261002_prompt_persistence.sql` version/checksum, all prompt controls disabled                                                                                  | UNRECORDED |
| Initial seed          | Independently validated `main` commit, schema/common/default blob digests, validator output, two operator approvals                                                              | UNRECORDED |
| Rollout window        | UTC start/end for shadow, common/default reads, personal reads, operator writes, personal writes, cohort, and general stages                                                     | UNRECORDED |
| Environment isolation | Redacted Preview/Production connector attachment and configuration-scope audit                                                                                                   | UNRECORDED |
| Metrics               | Resolution source, refresh/direct-edit freshness, p95 resolution latency, GitHub failures, rejection/fallback, confirmations, conflicts, verified activation, emergency duration | UNRECORDED |
| Security gates        | Zero unauthorized access and zero raw-data/content/identity/secret leakage, with dashboard query IDs                                                                             | UNRECORDED |
| Rollback rehearsal    | Deployment IDs and UTC window proving suggestions/writes, router, personal reads, and reads disabled in order; verified snapshot/emergency result                                | UNRECORDED |
| Approval              | Named operator approvals for every promotion and final 100% cohort                                                                                                               | UNRECORDED |
