# Database migrations

Migrations are run explicitly by the privileged deployment job. Application
startup must not execute DDL.

## Prompt persistence (PH-003)

`20261002_prompt_persistence.sql` is an expand-only migration and is safe to
deploy while the prompt hierarchy feature flags are disabled. The privileged
migration job must apply numbered files exactly once, in filename order, and
record both the filename and SHA-256 checksum in its deployment ledger. The
expected checksum is:

```text
703a4efb864f101297c0fc342a8241268057a8644e75c3ae8ca2fd047ceddf18  20261002_prompt_persistence.sql
```

Treat a different checksum for an already-recorded version as deployment
drift: stop rather than reapplying or accepting it. Application roles need
only DML privileges on these tables and function execution required by their
queries; they must not own the schema or receive DDL privileges. Rollback is by
disabling application behavior, not by dropping these tables.

The scheduled maintenance job should:

1. mark due `proposed` and `first_confirmed` requests `expired` (the repository
   method performs a compare-and-set update), then delete terminal request rows
   only after the product-approved recovery window (recommended minimum 30
   days);
2. retain every active snapshot and at least the two newest verified snapshots
   per repository identity, deleting inactive older snapshots only after the
   configured rollback window (recommended minimum 30 days); and
3. delete `prompt_audit_events` only after the security/audit retention period
   (recommended 400 days, or longer where policy requires it).

Cleanup must run in bounded batches. It never deletes or rewrites GitHub
history. Audit inserts expose only the fixed schema columns: pseudonymous
references, safe codes, correlation/commit identifiers, and time. Prompt
bodies, raw messages, usernames, and raw Telegram IDs must never be placed in
an audit column.

For `reset`, the change row binds `base_tree_sha` and a complete
`target_manifest` containing every affected path and base blob. This makes the
entire reset one compare-and-set operation against a known tree rather than a
sequence of independently based file writes.

Before applying `20261001_drop_legacy_skill_definition_tables.sql`, create (or
populate) the operator-owned attestation row after every legacy definition has
been copied to the protected GitHub default branch and every stable ID, owner,
status, and document has been reconciled:

```sql
CREATE TABLE IF NOT EXISTS skill_definition_migration_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  github_migration_completed_at timestamptz,
  reconciliation_completed_at timestamptz,
  github_commit_sha text CHECK (
    github_commit_sha IS NULL OR github_commit_sha ~ '^[0-9a-f]{40}$'
  ),
  CHECK (reconciliation_completed_at IS NULL OR github_migration_completed_at IS NOT NULL)
);

INSERT INTO skill_definition_migration_status (
  singleton,
  github_migration_completed_at,
  reconciliation_completed_at,
  github_commit_sha
) VALUES (true, now(), now(), '<reconciled-default-branch-commit>')
ON CONFLICT (singleton) DO UPDATE SET
  github_migration_completed_at = EXCLUDED.github_migration_completed_at,
  reconciliation_completed_at = EXCLUDED.reconciliation_completed_at,
  github_commit_sha = EXCLUDED.github_commit_sha;
```

Record the reconciliation evidence and backup ID before setting the timestamps.
The cleanup deliberately fails when the attestation table/row or either timestamp
is absent. It removes only legacy definition tables; shared PostgreSQL state and
the attestation remain available for operations and audit.
