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
