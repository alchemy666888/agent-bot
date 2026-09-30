# Rollback and recovery

## Safe code rollback

1. Disable the Telegram webhook, set `SKILLS_ENABLED=false`, and disable effectful capabilities so no new external side effects begin.
2. Allow bounded in-flight work to checkpoint; inspect `unknown_outcome` calls rather than replaying them.
3. Take and identify a consistent PostgreSQL backup. Do not drop, truncate, hand-edit, or restore over the only production database.
4. Confirm the target application understands the current `schema_migrations` version and installed event/content schemas. If it does, deploy it, run health and read-only owner/version/grant/audit checks, then canary with capabilities disabled.
5. Re-enable approved capabilities, skill execution, and the webhook in that order only after operator approval.

Schema changes use expand/migrate/contract so code rollback normally leaves the forward-compatible database in place. Do not run destructive down migrations merely to match old code.

## Database restoration

When data recovery is necessary, preserve the failed database for investigation, restore the selected pre-change backup to a **new isolated database**, and run `pnpm restore:verify` with all external adapters stubbed. Verify schema checksums, ownership/visibility, immutable revision hashes, current pointers, capability grants, selections, idempotency records, tool-call outcomes, and audit continuity. Determine the recovery point and reconcile any external effects after that point.

Promote the restored database only after two-user privacy tests and a dry-run restored selection pass. Rotate `DATABASE_URL`, deploy with skills/capabilities disabled, smoke test, then enable deliberately. Record the backup ID, lost interval, reconciliation decisions, commands, evidence, and approver in `docs/acceptance-evidence.md`.

A replacement Sandbox needs no filesystem restoration; it hydrates from PostgreSQL. Never recover installed skills from Sandbox scratch files or generated JSONL exports when a verified database backup exists.
