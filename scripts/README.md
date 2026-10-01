# PostgreSQL skill migration (operators only)

`migrate-skills-to-github.mjs` copies every active and historical normalized
skill version to the migration branch of `alchemy666888/skill`. It uses a
repeatable-read, read-only transaction and rejects privileged database roles.

Run only from a trusted operator workstation:

```sh
SKILL_MIGRATION_DATABASE_URL='…' GITHUB_TOKEN='…' \
  node scripts/migrate-skills-to-github.mjs
```

The ignored local state file maps source version IDs to commit SHAs and content
digests. Preserve it until cutover completes. The reconciliation report contains
only counts and hashes; review it and the migration PR. The script never merges.

Do **not** run the destructive database cleanup/contract migration until all of
these gates are recorded by an operator: the PR is merged, production has read
the catalog successfully from the merged GitHub SHA, and the report has no
unresolved differences. This script intentionally contains no cleanup command.
