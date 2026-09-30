# Deployment

PostgreSQL is the only durable store. A Vercel Sandbox is a disposable execution boundary and is hydrated from PostgreSQL; never deploy a configuration that treats its filesystem as a backup.

## Database and roles

Provision separate Preview and Production databases reachable from the Sandbox over IPv4/TLS. Preserve provider SSL parameters; for Aiven, set the complete PEM in `AIVEN_PG_CA`. Create separate roles:

- the **migrator** (`DATABASE_MIGRATOR_URL`) may create/alter schema and registry control-plane records;
- the **application** (`DATABASE_URL`) has only required DML/sequence access and cannot alter schema, mutate immutable versions/audit history, or register capabilities;
- the **backup/restore operator** is held outside the application and follows provider least privilege.

Do not make `DATABASE_MIGRATOR_URL` available to the running Next.js or Sandbox application. Production startup checks `schema_migrations` compatibility/checksums and fails closed; it does not create tables.

## Ordered rollout

1. Disable or leave disabled Telegram delivery and set `SKILLS_ENABLED=false`; disable effectful capability registry entries.
2. Create a provider-consistent backup and record its ID, schema version, UTC time, and encryption/retention location.
3. Run `DATABASE_URL="$DATABASE_MIGRATOR_URL" pnpm migrate` from the trusted deployment job. Apply expand/migrate/contract migrations only after old code compatibility is proven.
4. Run the migration acceptance suite against an empty database and an upgraded copy: `pnpm test -- tests/acceptance/skills/migration-restore.test.ts`.
5. Deploy with `pnpm build`. Configure all `.env.example` values; keep capability credentials server-side and adapter-scoped.
6. Check `/api/health` for schema compatibility, then exercise create → clarify → revise → approve → install → list → discover → select with capability execution still disabled.
7. Verify a second user cannot find/select the private skill. Verify an unregistered/ungranted capability is denied and audited before dispatch.
8. Run all acceptance suites and an isolated backup restoration. Link outputs/correlation IDs in `docs/acceptance-evidence.md`.
9. After operator sign-off, enable approved registry entries, set `SKILLS_ENABLED=true`, redeploy, perform one low-risk canary execution, and register/re-enable the Telegram webhook last.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test:unit && pnpm test:integration && pnpm test:contracts && pnpm test:e2e
pnpm test -- tests/acceptance/skills
pnpm build
```

Installed skills are private per owner. Only migrations/operator administration may create `visibility=global` skills. A release must not introduce shared/team/public visibility without an approved schema and authorization change.
