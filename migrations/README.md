# Database migrations

Migrations are run explicitly by the privileged deployment job. Application
startup must not execute DDL.

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
