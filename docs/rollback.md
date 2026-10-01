# Rollback and recovery

## DeepSeek routing rollback

The immediate rollback is configuration-only: change
`DEEPSEEK_ROUTING_MODE=enforced` to `shadow` and redeploy. This retains safe
decision telemetry while guaranteeing that shadow-selected skills/tools are not
executed. If the provider is failing, latency is harmful, or telemetry itself
must stop, set `DEEPSEEK_ROUTING_ENABLED=false` and redeploy; the existing route
continues without a classifier call. Confirm the dashboard has no new router
runs after disabling, then verify a direct answer and an existing skill route.
Do not delete routing records or increase timeout/confidence bounds during an
incident. Preserve the deployment ID, UTC window, threshold breach, and
approver for later review.

## Skill-store cutover rollback

During the defined pre-cleanup observation window, rollback changes the
server-only selector from `github` to `postgres` and redeploys the last
compatible artifact. The retained legacy tables are read-only throughout the
window. Freeze authoring first, preserve the GitHub branch and audit evidence,
and reconcile later under normal migration controls. Never copy a partially
migrated GitHub catalog into PostgreSQL, replay uncertain writes, or dual-write
during an incident.

After the observation window, the selector, PostgreSQL definition repository,
and dedicated tables no longer exist. Rollback is therefore a forward fix of
GitHub access/configuration or deployment of a schema-compatible release; it is
not a backend toggle. Restoring the retired backend requires a separately
reviewed recovery migration from the named pre-cutover backup and must not occur
inside incident response.

## Safe code rollback

1. Disable the Telegram webhook, set `SKILLS_ENABLED=false`, and disable effectful capabilities so no new external side effects begin.
2. Allow bounded in-flight work to checkpoint; inspect `unknown_outcome` calls rather than replaying them.
3. Take and identify a consistent PostgreSQL backup. Do not drop, truncate, hand-edit, or restore over the only production database.
4. Confirm the target application understands the current `schema_migrations` version and installed event/content schemas. If it does, deploy it, run health and read-only owner/version/grant/audit checks, then canary with capabilities disabled.
5. Re-enable approved capabilities, skill execution, and the webhook in that order only after operator approval.

Schema changes use expand/migrate/contract so code rollback normally leaves the forward-compatible database in place. Do not run destructive down migrations merely to match old code.

## Database restoration

When data recovery is necessary, preserve the failed database for investigation, restore the selected pre-change backup to a **new isolated database**, and run `pnpm restore:verify` with all external adapters stubbed. Verify schema checksums, remaining application row integrity, operational skill references, capability grants, selections, idempotency records, tool-call outcomes, and audit continuity. Restore skill definitions from a verified GitHub mirror/bundle and reconcile every database reference to a reachable immutable commit. Determine the recovery point and reconcile any external effects after that point.

Promote the restored database only after two-user privacy tests and a dry-run restored selection pass. Rotate `DATABASE_URL`, deploy with skills/capabilities disabled, smoke test, then enable deliberately. Record the backup ID, lost interval, reconciliation decisions, commands, evidence, and approver in `docs/acceptance-evidence.md`.

A replacement Sandbox needs no filesystem restoration; it hydrates application state from PostgreSQL and skill definitions from verified GitHub commits. Never recover skill definitions from Sandbox scratch files, database definition rows, or generated JSONL exports.
