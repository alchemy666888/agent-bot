# PostgreSQL skill migration (operators only)

`migrate-skills-to-github.mjs` copies every active and historical normalized
skill version to the migration branch of `alchemy666888/skill`. It uses a
repeatable-read, read-only transaction and rejects privileged database roles.

Run only from a trusted operator workstation:

```sh
SKILL_MIGRATION_DATABASE_URL='…' GITHUB_TOKEN='…' \
  node scripts/migrate-skills-to-github.mjs
```

The ignored, mode-`0600` local state file maps source version IDs to commit SHAs
and content digests. Preserve it on the operator workstation until cutover
completes, then destroy it under the incident-evidence retention policy. The
shareable reconciliation report contains only counts, hashes, and aggregate
mismatch reason counts: it never contains skill/version IDs, owners, repository
paths, or content. It compares stable/version IDs, owners, lifecycle status,
capabilities, and SHA-256 content digests. Review it and the migration PR. The
script never merges.

Do **not** run the destructive database cleanup/contract migration until all of
these gates are recorded by an operator: the PR is merged, production has read
the catalog successfully from the merged GitHub SHA, and the report has no
unresolved differences. This script intentionally contains no cleanup command.

## GitHub to PostgreSQL import

`import-skills-from-github.mjs` copies active skills from the GitHub default
branch into `skills` and `skill_versions` after `20261009_skill_definitions.sql`
has been applied. A version that already has the same content digest is skipped.
The script does not delete GitHub files.

```sh
DATABASE_URL='…' GITHUB_TOKEN='…' pnpm skills:import-from-github
```
