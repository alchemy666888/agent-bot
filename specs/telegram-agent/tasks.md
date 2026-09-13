# Tasks: Telegram Agent

Status: Approved

## Execution rules

- Execute tasks in dependency order.
- Do not mark a task Completed until all verification succeeds.
- Record implementation notes without rewriting approved task intent.
- Preserve the approved requirements and design; only task status and implementation notes may change during implementation.
- Keep every secret out of source, fixtures, snapshots, logs, and client bundles.
- Use the external services only in explicitly opt-in smoke tests; ordinary verification must use mocks or an ephemeral PostgreSQL instance.

## Task list

### TASK-001 — Scaffold the strict Next.js project baseline

Status: Completed

Requirements: REQ-NF-001, REQ-NF-008, REQ-NF-009, REQ-NF-010

Design: DES-001

Dependencies: None

Expected file or component changes:

- `package.json`, `pnpm-lock.yaml` — pin Next.js 16 and approved runtime/development dependencies and define verification scripts.
- `tsconfig.json`, `next.config.ts`, `eslint.config.*`, `.prettierrc*` — configure strict TypeScript, Next.js, linting, and formatting.
- `postcss.config.*`, `src/app/globals.css` — configure Tailwind and the accessible light-theme baseline.
- `src/app/layout.tsx`, `src/app/page.tsx` — create the root shell and deterministic dashboard redirect/landing behavior.
- `.gitignore`, `.npmrc`, runtime-version files — establish pnpm and Node.js 24 conventions without secrets.

Steps:

1. Initialize a greenfield App Router project using `src/` and strict TypeScript.
2. Pin exact resolved versions in the lockfile while declaring compatible Next.js 16 package ranges.
3. Add scripts for type checking, linting, formatting, unit tests, integration tests, E2E tests, migrations, webhook operations, and production build.
4. Establish semantic typography, color, focus, spacing, and responsive primitives without a component framework or theme switcher.

Verification:

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm build`

Completion criteria:

- A clean install and production build succeed on Node.js 24, strict TypeScript reports no errors, and the repository contains no generated secret values.

Implementation notes:

- Resumed on 2026-09-13 after registry access was enabled. Preflight confirmed
  Node.js `v24.15.0`, pnpm `10.28.1`, and successful npm metadata access. No
  credential value was copied into source, commands, logs, or tracked files.
- Implemented the strict Next.js 16.3.5 App Router baseline with exact dependency
  resolution, Node 24/pnpm conventions, strict TypeScript, ESLint, Prettier,
  Tailwind CSS, accessible light-theme primitives, and the root landing shell.
- Verification passed on 2026-09-13: `pnpm install --frozen-lockfile` (pnpm
  10.28.1), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`
  (Next.js 16.3.5; static `/` and `/_not-found` routes).

### TASK-002 — Implement typed configuration, retries, redaction, and structured logging

Status: Completed

Requirements: REQ-F-008, REQ-F-009, REQ-F-013, REQ-F-021, REQ-F-025, REQ-F-026, REQ-NF-003, REQ-NF-005, REQ-NF-006, REQ-NF-007, REQ-NF-011

Design: DES-002, DES-012, DES-018

Dependencies: TASK-001

Expected file or component changes:

- `.env.example` — document every required/optional server variable with no values.
- `src/modules/config/**` — add lazy, server-only, typed environment parsing and defaults.
- `src/modules/observability/logger.ts` — emit sanitized structured JSON events with correlation context.
- `src/modules/observability/errors.ts` — classify/redact failures and define safe persisted/user-facing forms.
- `src/modules/observability/retry.ts` — implement at-most-two retries with bounded jitter and deadline awareness.

Steps:

1. Implement independent configuration loaders for database, Telegram, DeepSeek/pricing, dashboard auth, and operator scripts.
2. Enforce the approved defaults for prompt, thinking, effort, base URL, and database pool size.
3. Implement stable error classes, transient-status classification, redaction, correlation IDs, and generic user messaging.
4. Implement retry control without any traffic quota, rate limiter, lockout, or CAPTCHA.

Verification:

- `pnpm test:unit -- config observability`
- `pnpm typecheck`
- Inspect `.env.example` and built client artifacts for seeded secret values.

Completion criteria:

- Missing/invalid relevant configuration fails closed at the consuming server entry point, permitted defaults are deterministic, retry count cannot exceed two, and redaction tests cover every prohibited secret category.

Implementation notes:

- Completed on 2026-09-13. Added independent lazy configuration parsers,
  approved DeepSeek/system/database defaults, safe error classification and
  redaction, structured JSON logging, and deadline-aware full-jitter retries
  capped at two retries. `.env.example` contains names/defaults only.
- Verification passed: `pnpm test:unit -- config observability` (5 tests),
  `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`. A seeded
  value scan of `.next/static` and `.next/server/app` returned no matches.

### TASK-003 — Create the PostgreSQL schema and initial migration

Status: Blocked

Requirements: REQ-F-004, REQ-F-014, REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-025, REQ-NF-005, REQ-NF-007

Design: DES-004, DES-013

Dependencies: TASK-001, TASK-002

Expected file or component changes:

- `drizzle.config.ts` — configure explicit migration generation/application without build-time execution.
- `src/modules/db/schema/**` — define all six approved tables, relations, checks, indexes, and types.
- `drizzle/**` — add the additive initial SQL migration and metadata.
- `scripts/migrate.ts` — provide the explicit migration entry point.

Steps:

1. Define `telegram_users`, `conversations`, `messages`, `telegram_updates`, `model_runs`, and `application_errors` exactly as approved.
2. Add the one-active-conversation partial unique index, update idempotency key, chronological/status indexes, decimal cost fields, and language-neutral message search index.
3. Exclude first/last names, raw Telegram payloads, hidden reasoning, sessions, login attempts, queues, secrets, and deletion/expiry jobs from the schema.
4. Make migration application explicit and safe to run repeatedly against an already-current schema.

Verification:

- `pnpm db:generate:check`
- `pnpm test:integration -- migrations schema`
- Inspect generated SQL for destructive statements and prohibited columns/tables.

Completion criteria:

- A blank supported PostgreSQL database migrates to the complete schema, a second migration run is a no-op/success, all constraints/indexes pass integration tests, and no excluded field/table exists.

Implementation notes:

- Blocked before implementation on 2026-09-13. TASK-001 and TASK-002 are
  completed, and the operator authorized the external PostgreSQL database, but
  `DATABASE_URL` is not present in the process environment. The supplied
  credential cannot be copied from chat into source, commands, logs, or tracked
  files under the approved secret-handling rules. TASK-003 requires applying the
  actual migration twice and verifying it against PostgreSQL, so it cannot be
  completed until a rotated connection string is injected server-side.
- Rechecked after the operator reported adding the environment secret on
  2026-09-13: `DATABASE_URL` is still unset in the execution process, no
  PostgreSQL-related environment-variable name is present, and neither
  `/run/secrets` nor `/workspace/.secrets` provides an injected secret file. No
  credential value was read or emitted during these checks.
- Resumed implementation on 2026-09-13 to prepare the schema and explicit
  migration without accessing an external database; database-dependent
  verification remains contingent on the secret reaching the shell process.
- Implemented all six Drizzle tables, approved checks/foreign keys/indexes,
  additive SQL migration metadata, and an explicit sanitized migration CLI.
  `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and
  `DATABASE_URL=<test-only-unreachable-url> pnpm db:generate:check` pass. The
  migration CLI also fails safely without leaking its test connection value.
  Completion remains blocked because `DATABASE_URL` is still absent from this
  process, so the authorized real-PostgreSQL migration and schema integration
  tests cannot be executed.
- The environment-settings screenshot confirms the secret is saved in the
  workspace definition, but a 2026-09-13 runtime recheck found it in neither the
  shell environment nor PID 1's environment. Workspace-definition changes are
  therefore not applied to this already-running container; it must be recreated
  before external-database verification can proceed.

### TASK-004 — Implement database access, repositories, checkpoints, and advisory locking

Status: Pending

Requirements: REQ-F-004, REQ-F-005, REQ-F-011, REQ-F-014, REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-NF-001, REQ-NF-002, REQ-NF-005, REQ-NF-006, REQ-NF-007, REQ-NF-010

Design: DES-003, DES-007, DES-008, DES-009

Dependencies: TASK-003

Expected file or component changes:

- `src/modules/db/client.ts` — add lazy `pg.Pool`, Drizzle binding, health query, and dedicated-client lifecycle.
- `src/modules/db/locks.ts` — acquire/release per-user PostgreSQL session advisory locks safely.
- `src/modules/db/repositories/users.ts` — upsert only approved Telegram profile fields.
- `src/modules/db/repositories/conversations.ts` — get/create/archive active conversations atomically.
- `src/modules/db/repositories/messages.ts` — persist/query message lifecycle and context windows.
- `src/modules/db/repositories/updates.ts` — implement idempotent insert and checkpoint transitions.
- `src/modules/db/repositories/model-runs.ts`, `errors.ts` — persist model accounting and sanitized failures.

Steps:

1. Build typed repositories with parameterized Drizzle/raw SQL and no application deletion methods.
2. Implement lossless Telegram bigint handling and transactional conversation/message operations.
3. Implement update state transitions that cannot regress and can resume at safe checkpoints.
4. Hold a dedicated connection for `pg_advisory_lock(telegram_user_id)` and guarantee unlock/release in `finally` or connection teardown.

Verification:

- `pnpm test:integration -- repositories checkpoints locks`
- `pnpm typecheck`
- Force an exception inside a held-lock callback and verify another connection can acquire the lock afterward.

Completion criteria:

- Repositories enforce schema invariants, duplicate update insertion is harmless, checkpoint progression/resumption is deterministic, and same-user locking serializes without cross-user locking.

Implementation notes:

- None yet.

### TASK-005 — Implement the provider-neutral model contract and DeepSeek client

Status: Pending

Requirements: REQ-F-006, REQ-F-007, REQ-F-008, REQ-F-009, REQ-F-010, REQ-F-013, REQ-F-017, REQ-F-025, REQ-F-027, REQ-NF-003, REQ-NF-005, REQ-NF-007, REQ-NF-010, REQ-NF-011

Design: DES-010, DES-011, DES-012, DES-013

Dependencies: TASK-002, TASK-004

Expected file or component changes:

- `src/modules/model/types.ts` — define the provider-neutral request, response, usage, and error contract.
- `src/modules/model/deepseek-client.ts` — implement validated native-fetch chat completions.
- `src/modules/model/cost.ts` — calculate precise price snapshots and estimates.
- `src/modules/model/index.ts` — expose a replaceable client factory without future tool implementations.

Steps:

1. Send the fixed `deepseek-v4-pro` model, non-streaming request, configured thinking toggle, and validated reasoning effort.
2. Validate HTTP/body contracts, capture safe provider request/usage metadata, and discard `reasoning_content` immediately.
3. Abort before the Vercel deadline leaves insufficient finalization time.
4. Snapshot configured prices and calculate nullable input/output/total estimates with decimal-safe arithmetic.
5. Map transient and deterministic failures into the shared error taxonomy.

Verification:

- `pnpm test:unit -- model cost`
- `pnpm test:contract -- deepseek`
- Verify seeded `reasoning_content` appears in neither returned domain objects, logs, nor persistence fixtures.

Completion criteria:

- Contract tests cover success, thinking on/off, usage absent, malformed response, timeout, 4xx, 429, and 5xx; only final `content` leaves the adapter; historical cost inputs/results are exact and stable.

Implementation notes:

- None yet.

### TASK-006 — Implement the grammY Telegram transport adapter

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-003, REQ-F-010, REQ-F-012, REQ-F-013, REQ-F-026, REQ-NF-003, REQ-NF-005, REQ-NF-006, REQ-NF-010, REQ-NF-011

Design: DES-006, DES-012

Dependencies: TASK-001, TASK-002

Expected file or component changes:

- `src/modules/telegram/bot.ts` — lazily create the grammY client with server-only token handling.
- `src/modules/telegram/types.ts`, `validation.ts` — define bounded supported-update domain types.
- `src/modules/telegram/commands.ts` — define deterministic start/help/new/unsupported responses.
- `src/modules/telegram/delivery.ts` — typing, MarkdownV2 normalization, 4096-safe splitting, ordered sends, and plain-text fallback.
- `src/modules/telegram/errors.ts` — translate Telegram errors and retry hints safely.

Steps:

1. Convert a validated update into a minimal domain event without carrying raw payload/profile fields.
2. Implement approved command text, including no privacy/retention notice.
3. Implement typing activity and complete non-streamed answer delivery in safe ordered chunks.
4. Preserve supported MarkdownV2 where possible and fall back to plain text without another model request.
5. Avoid adding transport quotas, group handling, rich streaming, media handling, or inline behavior.

Verification:

- `pnpm test:unit -- telegram`
- `pnpm test:contract -- telegram`
- Validate boundary cases at 1, 4096, 4097, multiline code-block, and malformed-Markdown lengths.

Completion criteria:

- Supported updates map losslessly, unsupported content cannot become a model prompt, command responses are exact, and every response is delivered at most once in Telegram-valid chunks with tested fallback.

Implementation notes:

- None yet.

### TASK-007 — Implement ordered conversation orchestration

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-003, REQ-F-004, REQ-F-005, REQ-F-006, REQ-F-007, REQ-F-008, REQ-F-009, REQ-F-010, REQ-F-011, REQ-F-012, REQ-F-013, REQ-F-014, REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-025, REQ-F-026, REQ-F-027, REQ-NF-002, REQ-NF-005, REQ-NF-006, REQ-NF-007, REQ-NF-010, REQ-NF-011

Design: DES-007, DES-008, DES-009, DES-010, DES-011, DES-012, DES-013

Dependencies: TASK-004, TASK-005, TASK-006

Expected file or component changes:

- `src/modules/conversation/orchestrator.ts` — coordinate locks, checkpoints, commands, model calls, persistence, and delivery.
- `src/modules/conversation/context.ts` — select/chronologically assemble the system prompt and latest 20 message pairs.
- `src/modules/conversation/state.ts` — define allowed resumable outcomes and generic error path.
- `src/modules/conversation/language.ts` — compose the latest-message language-following instruction without language detection services.

Steps:

1. Implement the approved successful-turn, duplicate/resume, command, `/new`, unsupported-input, and failure flows.
2. Ensure model calls never occur before the prompt/idempotency checkpoint is durable.
3. Reuse a persisted `model_complete` response for delivery recovery; never regenerate after that checkpoint.
4. Persist command/system responses, model runs, messages, delivery IDs, timing, statuses, and sanitized errors.
5. Guarantee lock release and terminal HTTP outcome decisions without cross-user state in memory.

Verification:

- `pnpm test:unit -- conversation`
- `pnpm test:integration -- orchestration`
- Fault-inject at every checkpoint and verify the next invocation resumes without duplicate prompt or delivered reply.

Completion criteria:

- Every key flow and edge case reaches the approved checkpoint/state, context contains at most 20 recent pairs plus the prompt, same-user order is deterministic, and terminal duplicates produce no model or Telegram call.

Implementation notes:

- None yet.

### TASK-008 — Expose the secure synchronous Telegram webhook

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-011, REQ-F-013, REQ-F-014, REQ-F-015, REQ-F-016, REQ-F-017, REQ-NF-003, REQ-NF-005, REQ-NF-006, REQ-NF-011

Design: DES-005, DES-007, DES-008, DES-009

Dependencies: TASK-007

Expected file or component changes:

- `src/app/api/telegram/webhook/route.ts` — implement POST-only secret validation, bounded runtime parsing, orchestration, and terminal status mapping.
- `src/app/api/telegram/webhook/**.test.ts` — verify HTTP boundary and redelivery behavior.
- `vercel.json` or route configuration — assign Node.js, 300-second duration, and deployment-selected Asian region configuration point.

Steps:

1. Validate the webhook secret using fixed-length keyed digests before JSON parsing.
2. Reject non-POST and invalid/oversized requests without exposing details.
3. Acknowledge intentionally ignored update types and route supported private messages to synchronous orchestration.
4. Return 2xx only for terminal/ignored work and non-2xx when Telegram redelivery can safely resume.

Verification:

- `pnpm test:integration -- webhook`
- Exercise missing/wrong secret, malformed JSON, out-of-scope update, first delivery, concurrent duplicate, checkpoint resume, and completed duplicate.
- `pnpm build`

Completion criteria:

- The route performs no secret-dependent parsing before authentication, valid updates use the orchestrator, duplicates are idempotent, and HTTP status behavior matches the approved recovery design.

Implementation notes:

- None yet.

### TASK-009 — Implement stateless dashboard authentication

Status: Pending

Requirements: REQ-F-019, REQ-F-020, REQ-F-021, REQ-F-026, REQ-NF-003, REQ-NF-004, REQ-NF-005

Design: DES-014

Dependencies: TASK-001, TASK-002

Expected file or component changes:

- `src/modules/auth/session.ts` — sign, validate, expire, and clear the HMAC session cookie.
- `src/modules/auth/secret.ts` — compare arbitrary non-empty login secrets using fixed-length keyed digests.
- `src/modules/auth/guards.ts` — fail-closed page/query/action guards.
- `src/app/login/page.tsx`, `src/app/login/actions.ts` — accessible login and same-origin POST processing.
- `src/app/logout/route.ts` or protected action — same-origin POST logout.

Steps:

1. Implement the expiry-only signed payload and the exact secure `__Host-telegram-agent-session` cookie attributes.
2. Validate signature/expiry on every protected entry and clear invalid/expired cookies.
3. Redirect authenticated login requests and unauthenticated dashboard requests appropriately.
4. Implement no login persistence, throttle, lockout, CAPTCHA, or IP restriction.

Verification:

- `pnpm test:unit -- auth`
- `pnpm test:integration -- auth-routes`
- Test missing/empty/wrong/right secrets, tampering, expiry at boundary, secret rotation, signing-key rotation, cross-origin POST, and logout.

Completion criteria:

- Only the configured arbitrary secret grants a 24-hour session, every invalid state fails closed before protected data access, logout expires the cookie, and the secret appears in no URL/storage/log response.

Implementation notes:

- None yet.

### TASK-010 — Implement protected read-only dashboard queries

Status: Pending

Requirements: REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-022, REQ-F-023, REQ-F-024, REQ-F-025, REQ-NF-004, REQ-NF-005, REQ-NF-007, REQ-NF-010

Design: DES-015

Dependencies: TASK-004, TASK-009

Expected file or component changes:

- `src/modules/dashboard/params.ts` — validate/normalize `q`, `page`, IDs, and 50-row pagination.
- `src/modules/dashboard/queries/overview.ts` — aggregate approved totals.
- `src/modules/dashboard/queries/users.ts`, `conversations.ts`, `messages.ts`, `model-runs.ts`, `errors.ts` — parameterized, read-only listing/detail/search queries.
- `src/modules/dashboard/view-models.ts` — expose display-safe, secret-free records.

Steps:

1. Apply session guards within every query entry point, not only the dashboard layout.
2. Implement newest-first deterministic pagination and page normalization.
3. Implement applicable identifier/text/status search using approved indexes and bound parameters.
4. Return complete message content and sanitized error fields without mutation APIs.

Verification:

- `pnpm test:integration -- dashboard-queries`
- Attempt SQL/search metacharacter input and unauthenticated direct query invocation.
- Inspect exports to confirm no create/update/delete methods are exposed.

Completion criteria:

- Every dashboard category returns correct authorized data, search/pagination are deterministic and injection-safe, unauthenticated access fails before SQL, and no mutation interface exists.

Implementation notes:

- None yet.

### TASK-011 — Build the responsive accessible dashboard UI

Status: Pending

Requirements: REQ-F-019, REQ-F-020, REQ-F-022, REQ-F-023, REQ-F-024, REQ-F-025, REQ-NF-004, REQ-NF-007, REQ-NF-008, REQ-NF-009

Design: DES-014, DES-015, DES-016

Dependencies: TASK-010

Expected file or component changes:

- `src/app/dashboard/layout.tsx` — protected responsive shell, navigation, and logout.
- `src/app/dashboard/page.tsx` — overview totals.
- `src/app/dashboard/users/page.tsx` — user list/search/pagination.
- `src/app/dashboard/conversations/page.tsx`, `src/app/dashboard/conversations/[id]/page.tsx` — conversation list/detail/history.
- `src/app/dashboard/messages/page.tsx`, `model-runs/page.tsx`, `errors/page.tsx` — approved data views.
- `src/components/dashboard/**` — semantic cards, tables/list fallbacks, search, pagination, status, empty, and error components.
- `src/app/**/loading.tsx`, `error.tsx`, `not-found.tsx` — accessible route states.

Steps:

1. Render all data with Server Components and no client polling or mutation controls.
2. Preserve search in URL parameters and provide keyboard-operable pagination.
3. Use responsive stacked views at narrow widths and semantic tables where width permits.
4. Add no-store/private headers, restrictive security headers, visible focus, labels, and WCAG 2.2 AA contrast.

Verification:

- `pnpm test:e2e -- dashboard`
- `pnpm test:a11y`
- Manually inspect 320px, desktop, keyboard-only, empty, long-content, and error states.

Completion criteria:

- All approved routes render correct read-only data after login, remain usable at 320px without page-level horizontal scrolling, meet automated/manual accessibility checks, and update only on navigation/manual refresh.

Implementation notes:

- None yet.

### TASK-012 — Add health, webhook operations, and Vercel deployment configuration

Status: Pending

Requirements: REQ-F-001, REQ-F-007, REQ-F-021, REQ-NF-001, REQ-NF-003, REQ-NF-011

Design: DES-002, DES-017, DES-020

Dependencies: TASK-002, TASK-004, TASK-006, TASK-008

Expected file or component changes:

- `src/app/api/health/route.ts` — bounded, sanitized process/database readiness.
- `scripts/telegram-webhook-set.ts`, `telegram-webhook-info.ts`, `telegram-webhook-delete.ts` — operator-safe Telegram setup commands.
- `vercel.json` — Node.js function duration and explicit operator-selected supported Asian region.
- `docs/deployment.md` — environment, region, migration, deploy, webhook, smoke test, and rollback runbook.

Steps:

1. Implement a bounded `SELECT 1` health route returning only `ready` or `not_ready`.
2. Implement webhook scripts with HTTPS URL, distinct secret token, `allowed_updates: ['message']`, and no default pending-update deletion.
3. Configure 300-second Node.js webhook execution and document selection of the nearest supported Asian region.
4. Document explicit predeploy migration and previous-deployment rollback with operator-owned database backup/restore.

Verification:

- `pnpm test:integration -- health operator-scripts`
- Run webhook scripts against a mock Telegram server.
- `pnpm build`
- Inspect `vercel.json` and deployment docs for absence of credentials and automatic migration/cron configuration.

Completion criteria:

- Readiness is minimal and accurate, all three webhook operations generate correct safe API calls, Vercel configuration fits Hobby, and the runbook is complete without adding cron, queues, or secrets.

Implementation notes:

- None yet.

### TASK-013 — Complete unit and external contract verification

Status: Pending

Requirements: REQ-F-002, REQ-F-003, REQ-F-006, REQ-F-007, REQ-F-008, REQ-F-009, REQ-F-010, REQ-F-012, REQ-F-013, REQ-F-021, REQ-F-025, REQ-F-027, REQ-NF-003, REQ-NF-005, REQ-NF-006, REQ-NF-007, REQ-NF-010, REQ-NF-011

Design: DES-002, DES-006, DES-010, DES-011, DES-012, DES-013, DES-018, DES-019

Dependencies: TASK-005, TASK-006, TASK-007, TASK-008, TASK-009

Expected file or component changes:

- `tests/unit/**` and colocated `*.test.ts` — complete unit coverage for pure policies/utilities.
- `tests/contracts/deepseek/**` — validate DeepSeek request/response/error contracts through an HTTP mock.
- `tests/contracts/telegram/**` — validate Telegram request/error/formatting contracts through an HTTP mock.
- `vitest.config.*`, `tests/setup/**` — separate deterministic unit and contract projects.

Steps:

1. Close every unit/contract case listed in the approved testing strategy.
2. Use seeded forbidden values to prove redaction and hidden-reasoning exclusion.
3. Use fake timers/randomness control for retries, expiry, and latency.
4. Keep live provider tests opt-in and outside ordinary CI.

Verification:

- `pnpm test:unit`
- `pnpm test:contract`
- `pnpm test:coverage`

Completion criteria:

- All pure behaviors and external contract variants pass deterministically, important branches have explicit assertions, and ordinary tests make no live Telegram or DeepSeek request.

Implementation notes:

- None yet.

### TASK-014 — Verify real-PostgreSQL state, recovery, and concurrency behavior

Status: Pending

Requirements: REQ-F-004, REQ-F-005, REQ-F-011, REQ-F-014, REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-025, REQ-NF-002, REQ-NF-005, REQ-NF-006, REQ-NF-007

Design: DES-003, DES-004, DES-007, DES-008, DES-009, DES-013, DES-019

Dependencies: TASK-003, TASK-004, TASK-007, TASK-008, TASK-010

Expected file or component changes:

- `tests/integration/db/**` — migration, constraint, repository, search, and numeric-accounting tests.
- `tests/integration/orchestration/**` — fault-injected checkpoint/redelivery and command tests.
- `tests/integration/concurrency/**` — same-user ordering and 10-distinct-conversation isolation tests.
- `tests/helpers/postgres/**` — reproducible ephemeral PostgreSQL lifecycle and fixtures.

Steps:

1. Run the actual migration in an ephemeral PostgreSQL instance.
2. Verify constraints, search, transaction rollback, bigint fidelity, decimal costs, and indefinite/no-delete schema behavior.
3. Fault-inject before/after every checkpoint and assert resume semantics and at-most-one delivery.
4. Drive at least 10 simultaneous distinct users plus overlapping messages for one user and record isolation/order evidence.

Verification:

- `pnpm test:integration`
- Repeat the concurrency suite multiple times with randomized scheduling.

Completion criteria:

- Real PostgreSQL tests prove every database invariant, lock cleanup, context isolation, same-user order, checkpoint recovery, and no duplicate persisted/delivered reply.

Implementation notes:

- None yet.

### TASK-015 — Complete browser, accessibility, and security verification

Status: Pending

Requirements: REQ-F-001, REQ-F-005, REQ-F-014, REQ-F-019, REQ-F-020, REQ-F-021, REQ-F-022, REQ-F-023, REQ-F-024, REQ-F-025, REQ-F-026, REQ-NF-003, REQ-NF-004, REQ-NF-005, REQ-NF-008, REQ-NF-009, REQ-NF-011

Design: DES-005, DES-009, DES-014, DES-015, DES-016, DES-017, DES-019

Dependencies: TASK-011, TASK-012, TASK-013, TASK-014

Expected file or component changes:

- `playwright.config.ts`, `tests/e2e/**` — full login/dashboard/webhook browser-to-database stories.
- `tests/accessibility/**` — automated and keyboard/focus/contrast verification.
- `tests/security/**` — protected-route, header, client-bundle, log, and forbidden-data leakage assertions.
- `tests/fixtures/**` — sanitized long-content, empty-state, error, and pagination datasets.

Steps:

1. Exercise login, expiry, logout, every dashboard route, search/pagination, manual refresh, empty/error/long-content states, and direct unauthorized access.
2. Exercise an HTTP Telegram webhook turn through mocked providers into real PostgreSQL and dashboard display.
3. Verify 320px/current-browser behavior, keyboard navigation, visible focus, labels, and WCAG 2.2 AA checks.
4. Scan client output, HTTP responses/headers, structured logs, and persisted rows for seeded credentials, names, raw payloads, and hidden reasoning.

Verification:

- `pnpm test:e2e`
- `pnpm test:a11y`
- `pnpm test:security`
- `pnpm build`

Completion criteria:

- The complete user/operator story passes, protected data never crosses the auth boundary, all accessibility/responsive criteria pass, and prohibited data is absent from every inspected surface.

Implementation notes:

- None yet.

### TASK-016 — Finalize operator documentation and release evidence

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-018, REQ-F-026, REQ-F-027, REQ-NF-001, REQ-NF-003, REQ-NF-010, REQ-NF-011

Design: DES-001, DES-017, DES-020

Dependencies: TASK-012, TASK-013, TASK-014, TASK-015

Expected file or component changes:

- `README.md` — project purpose, boundaries, local setup, commands, architecture summary, and explicit exclusions.
- `docs/deployment.md` — finalize validated production migration/deploy/webhook/smoke-test/rollback steps.
- `docs/operations.md` — dashboard, health, logs, error recovery, pricing updates, secret rotation, and accepted risks.
- `specs/telegram-agent/tasks.md` — record actual verification evidence and final task status during implementation only.

Steps:

1. Document prerequisites and all operator-owned credentials without example secret values.
2. Document the lack of application rate limits, login throttling, retention expiry, deletion, moderation service, and agent tools.
3. Document secret rotation effects, region selection, explicit migrations, webhook recovery, and previous-deployment rollback.
4. Run the complete clean verification suite and record concise evidence.

Verification:

- `pnpm install --frozen-lockfile`
- `pnpm format:check && pnpm lint && pnpm typecheck`
- `pnpm test:unit && pnpm test:contract && pnpm test:integration && pnpm test:e2e && pnpm test:a11y && pnpm test:security`
- `pnpm build`
- Follow the deployment runbook against a non-production test configuration or mocks without performing an unauthorized external deployment.

Completion criteria:

- A new maintainer can configure, migrate, test, deploy, register the webhook, inspect operation, rotate secrets, and roll back from the documentation; all verification passes with evidence and no scope expansion.

Implementation notes:

- None yet.

## Coverage matrix

| Requirement or design ID | Implementing tasks |
|---|---|
| REQ-F-001 | TASK-006, TASK-007, TASK-008, TASK-012, TASK-015, TASK-016 |
| REQ-F-002 | TASK-006, TASK-007, TASK-008, TASK-013, TASK-016 |
| REQ-F-003 | TASK-006, TASK-007, TASK-013 |
| REQ-F-004 | TASK-003, TASK-004, TASK-007, TASK-014 |
| REQ-F-005 | TASK-004, TASK-007, TASK-014, TASK-015 |
| REQ-F-006 | TASK-005, TASK-007, TASK-013 |
| REQ-F-007 | TASK-005, TASK-007, TASK-012, TASK-013 |
| REQ-F-008 | TASK-002, TASK-005, TASK-007, TASK-013 |
| REQ-F-009 | TASK-002, TASK-005, TASK-007, TASK-013 |
| REQ-F-010 | TASK-005, TASK-006, TASK-007, TASK-013 |
| REQ-F-011 | TASK-004, TASK-007, TASK-008, TASK-014 |
| REQ-F-012 | TASK-005, TASK-006, TASK-007, TASK-013 |
| REQ-F-013 | TASK-002, TASK-005, TASK-006, TASK-007, TASK-008, TASK-013 |
| REQ-F-014 | TASK-003, TASK-004, TASK-007, TASK-008, TASK-014, TASK-015 |
| REQ-F-015 | TASK-003, TASK-004, TASK-007, TASK-008, TASK-010, TASK-014 |
| REQ-F-016 | TASK-003, TASK-004, TASK-007, TASK-008, TASK-010, TASK-014 |
| REQ-F-017 | TASK-003, TASK-004, TASK-005, TASK-007, TASK-008, TASK-010, TASK-014 |
| REQ-F-018 | TASK-003, TASK-004, TASK-007, TASK-010, TASK-014, TASK-016 |
| REQ-F-019 | TASK-009, TASK-011, TASK-015 |
| REQ-F-020 | TASK-009, TASK-011, TASK-015 |
| REQ-F-021 | TASK-002, TASK-009, TASK-012, TASK-013, TASK-015 |
| REQ-F-022 | TASK-010, TASK-011, TASK-015 |
| REQ-F-023 | TASK-010, TASK-011, TASK-015 |
| REQ-F-024 | TASK-010, TASK-011, TASK-015 |
| REQ-F-025 | TASK-002, TASK-003, TASK-005, TASK-007, TASK-010, TASK-011, TASK-013, TASK-014, TASK-015 |
| REQ-F-026 | TASK-002, TASK-006, TASK-007, TASK-009, TASK-015, TASK-016 |
| REQ-F-027 | TASK-005, TASK-007, TASK-013, TASK-016 |
| REQ-NF-001 | TASK-001, TASK-004, TASK-012, TASK-016 |
| REQ-NF-002 | TASK-004, TASK-007, TASK-014 |
| REQ-NF-003 | TASK-002, TASK-005, TASK-006, TASK-008, TASK-009, TASK-012, TASK-013, TASK-015, TASK-016 |
| REQ-NF-004 | TASK-009, TASK-010, TASK-011, TASK-015 |
| REQ-NF-005 | TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009, TASK-010, TASK-013, TASK-014, TASK-015 |
| REQ-NF-006 | TASK-002, TASK-004, TASK-006, TASK-007, TASK-008, TASK-013, TASK-014 |
| REQ-NF-007 | TASK-002, TASK-003, TASK-004, TASK-005, TASK-007, TASK-010, TASK-011, TASK-013, TASK-014 |
| REQ-NF-008 | TASK-001, TASK-011, TASK-015 |
| REQ-NF-009 | TASK-001, TASK-011, TASK-015 |
| REQ-NF-010 | TASK-001, TASK-004, TASK-005, TASK-006, TASK-007, TASK-010, TASK-013, TASK-016 |
| REQ-NF-011 | TASK-002, TASK-005, TASK-006, TASK-007, TASK-008, TASK-012, TASK-013, TASK-015, TASK-016 |
| DES-001 | TASK-001, TASK-016 |
| DES-002 | TASK-002, TASK-012, TASK-013 |
| DES-003 | TASK-004, TASK-014 |
| DES-004 | TASK-003, TASK-014 |
| DES-005 | TASK-008, TASK-015 |
| DES-006 | TASK-006, TASK-013 |
| DES-007 | TASK-004, TASK-007, TASK-008, TASK-014 |
| DES-008 | TASK-004, TASK-007, TASK-008, TASK-014 |
| DES-009 | TASK-004, TASK-007, TASK-008, TASK-014, TASK-015 |
| DES-010 | TASK-005, TASK-007, TASK-013 |
| DES-011 | TASK-005, TASK-007, TASK-013 |
| DES-012 | TASK-002, TASK-005, TASK-006, TASK-007, TASK-013 |
| DES-013 | TASK-003, TASK-005, TASK-007, TASK-014 |
| DES-014 | TASK-009, TASK-011, TASK-015 |
| DES-015 | TASK-010, TASK-011, TASK-015 |
| DES-016 | TASK-011, TASK-015 |
| DES-017 | TASK-012, TASK-015, TASK-016 |
| DES-018 | TASK-002, TASK-013 |
| DES-019 | TASK-013, TASK-014, TASK-015 |
| DES-020 | TASK-012, TASK-016 |
