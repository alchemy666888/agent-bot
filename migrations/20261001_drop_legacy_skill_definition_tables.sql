-- Contract migration: legacy PostgreSQL skill definitions are removed only after
-- the out-of-band GitHub copy and reconciliation have both been attested.
-- This file is applied by the privileged migration job, never application startup.

DO $migration$
DECLARE
  github_migration_complete boolean;
  reconciliation_complete boolean;
BEGIN
  IF to_regclass('skill_definition_migration_status') IS NULL THEN
    RAISE EXCEPTION
      'skill cleanup refused: skill_definition_migration_status is missing';
  END IF;

  EXECUTE
    'SELECT github_migration_completed_at IS NOT NULL,
            reconciliation_completed_at IS NOT NULL
       FROM skill_definition_migration_status
      WHERE singleton = true'
    INTO github_migration_complete, reconciliation_complete;

  IF NOT COALESCE(github_migration_complete, false)
     OR NOT COALESCE(reconciliation_complete, false) THEN
    RAISE EXCEPTION
      'skill cleanup refused: GitHub migration and reconciliation must be complete';
  END IF;
END
$migration$;

-- Explicit names make this safe for databases in which only part of the legacy
-- schema was created. Child tables precede their parents.
DO $cleanup$
BEGIN
  IF to_regclass('skill_versions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS skill_versions_immutable_approval ON skill_versions;
  END IF;
END
$cleanup$;
DROP FUNCTION IF EXISTS protect_approved_skill_version();

DROP TABLE IF EXISTS skill_installation_failures;
DROP TABLE IF EXISTS skill_capabilities;
DROP TABLE IF EXISTS skill_tools;
DROP TABLE IF EXISTS skill_triggers;
DROP TABLE IF EXISTS skill_owners;
DROP TABLE IF EXISTS skill_versions;
DROP TABLE IF EXISTS skills;
