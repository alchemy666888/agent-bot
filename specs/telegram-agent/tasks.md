# Tasks: Telegram Agent on Vercel Sandbox Drive

Status: Approved

## Execution rules

- Execute tasks in dependency order.
- Do not begin implementation until all four SDD documents are approved.
- Mark a task `In Progress` before changing application code and `Completed` only after every verification and completion criterion succeeds.
- Preserve unrelated user changes and repository-local instructions.
- Keep durable application data exclusively as ordinary files on the named Vercel Sandbox Drive.
- Do not add databases, object stores, a second persistent service, application-defined restrictions, moderation infrastructure, or future agent tools.
- Record concise implementation notes and verification evidence without rewriting approved task intent.

## Task list

### TASK-001 — Establish the project baseline and validated configuration

Status: Pending

Requirements: REQ-F-008, REQ-F-009, REQ-F-033, REQ-NF-001, REQ-NF-002, REQ-NF-007, REQ-NF-014, REQ-NF-015

Design: DES-001

Dependencies: None

Expected file or component changes:

- `package.json`, `pnpm-lock.yaml` — Next.js, React, TypeScript, Sandbox SDK, schema validation, test, lint, format, and build tooling.
- `tsconfig.json`, `next.config.ts`, lint/format/test configuration — strict Node.js-compatible builds and deterministic checks.
- `.env.example`, `src/server/config/**` — variable names, lazy server-only validation, defaults, and the `sin1` invariant.
- `src/app/**`, `src/server/**`, `src/shared/**`, `src/worker/**`, `tests/**` — approved greenfield module boundaries.

Steps:

1. Initialize the App Router project with pnpm, strict TypeScript, and Node.js runtime defaults.
2. Add scripts for type checking, linting, formatting, unit/integration/contract/browser tests, worker bundling, and builds.
3. Define separate configuration readers so each entry point loads only its required settings.
4. Apply the approved prompt, thinking, reasoning-effort, and DeepSeek URL defaults.
5. Reject an explicitly supplied Sandbox region other than `sin1`.
6. Prevent browser code from importing secret-bearing server or worker modules.

Verification:

- Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`.
- Test valid settings, missing/empty required settings, invalid prices/booleans, and a non-`sin1` region.
- Inspect dependencies and bundles for excluded database, storage, throttling, moderation, and tool packages.

Completion criteria:

- The project builds reproducibly with strict typing and the approved boundaries.
- `.env.example` names all approved variables without values.
- Configuration fails closed at the relevant server/worker entry point and never enters client bundles.

Implementation notes:

- None yet.

### TASK-002 — Define shared contracts, identifiers, redaction, and capability boundary

Status: Pending

Requirements: REQ-F-018, REQ-F-025, REQ-F-034, REQ-NF-007, REQ-NF-009, REQ-NF-011, REQ-NF-014

Design: DES-014, DES-021, DES-024

Dependencies: TASK-001

Expected file or component changes:

- `src/shared/contracts/**` — versioned worker, model, view-model, and safe-error schemas.
- `src/shared/ids.ts`, `src/shared/redaction.ts` — identifiers and centralized data exclusion.
- `src/shared/capabilities.ts` — inert future capability interface.
- `tests/unit/shared/**` — contract, identifier, redaction, and boundary tests.

Steps:

1. Define `contractVersion: 1` schemas for every approved worker operation and response.
2. Define provider-neutral model requests, responses, usage, and classified errors.
3. Add UUIDv7 and decimal Telegram identifier helpers.
4. Exclude credentials, authorization, cookies, raw provider bodies, stack traces, hidden reasoning, and unbounded errors.
5. Reserve the future capability interface after orchestration without adapters, registration, UI, or executable behavior.

Verification:

- Validate good and malformed fixtures for every contract.
- Test redaction with Telegram, DeepSeek, Vercel, bearer, cookie, and OIDC secret-shaped data.
- Confirm the capability module has no tool implementation or runtime registration.

Completion criteria:

- Next.js and worker modules share runtime-validated contracts without implementation coupling.
- Unsafe fields are rejected or sanitized before logging, persistence, or display.
- Future extensibility is represented only by an inactive interface.

Implementation notes:

- None yet.

### TASK-003 — Implement the private Sandbox controller and worker bootstrap

Status: Pending

Requirements: REQ-F-012, REQ-F-014, REQ-F-025, REQ-F-033, REQ-NF-001, REQ-NF-002, REQ-NF-007, REQ-NF-014, REQ-NF-015

Design: DES-004, DES-005, DES-006

Dependencies: TASK-001, TASK-002

Expected file or component changes:

- `src/server/sandbox/controller.ts`, `sdk-adapter.ts` — named Drive/Sandbox lifecycle and testable SDK boundary.
- `src/server/sandbox/transport.ts` — private command files, deadlines, response validation, streaming, and cleanup.
- `src/worker/cli.ts`, worker build configuration — approved operation dispatcher and build-hashed standalone bundle.
- `tests/unit/server/sandbox/**`, `tests/contracts/sandbox/**` — lifecycle and protocol tests.

Steps:

1. Use named Drive/Sandbox `getOrCreate` calls with explicit `sin1`, `/workspace`, persistence, resume, and a Hobby-compatible timeout.
2. Validate returned identities, region, and mount; never configure ports or failover.
3. Install or refresh the worker outside the Drive using an idempotent build hash.
4. Send validated requests through unique non-Drive files, invoke named operations, validate responses, and clean up in `finally`.
5. Pass only operation-required secrets through command environment variables.
6. Bridge archive streams without whole-file buffering.

Verification:

- Mock new, resumed, stale, wrong-region, wrong-mount, occupied-Drive, quota, timeout, malformed-response, and cleanup paths.
- Assert explicit `sin1`, one mount, no ports/failover, and least-privileged command environments.
- Verify a traced worker bundle is deployed outside `/workspace`.

Completion criteria:

- Server routes invoke private worker commands using automatic production OIDC or the locally pulled token.
- Stale compute can be replaced while the Drive remains authoritative.
- Lifecycle mismatches fail safely without a competing writer.

Implementation notes:

- None yet.

### TASK-004 — Implement Drive files, append-only events, projections, and recovery

Status: Pending

Requirements: REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-019, REQ-F-020, REQ-F-021, REQ-F-022, REQ-NF-003, REQ-NF-005, REQ-NF-006, REQ-NF-009

Design: DES-007, DES-009

Dependencies: TASK-001, TASK-002

Expected file or component changes:

- `src/worker/persistence/layout.ts`, `schemas/**` — canonical paths, manifest, event envelopes, projections, and compatibility.
- `src/worker/persistence/event-store.ts`, `atomic-json.ts` — append/fsync and atomic state replacement.
- `src/worker/persistence/projector.ts`, `recovery.ts` — derived state, tail quarantine, and replay.
- `tests/integration/persistence/**` — local-filesystem durability and recovery tests.

Steps:

1. Initialize schema-versioned `data/records`, `data/state`, `data/recovery`, and recreatable `runtime/locks`.
2. Serialize validated events as one compact UTF-8 JSON object plus one newline in UTC-month partitions.
3. Fsync each event before atomically replacing and directory-syncing derived projections.
4. Preserve revisions, source-event links, first-seen immutability, and approved entity fields.
5. Rotate without deleting or expiring records.
6. Validate manifest, active tails, and projections on create/resume; quarantine only partial trailing bytes and replay committed events.
7. Reject prohibited personal data, raw inputs, secrets, cookies, hidden reasoning, and unsanitized errors at schema boundaries.

Verification:

- Test initialization, append order, sync ordering, atomic replacement, rotation, and schema rejection.
- Inject interruption after append and before projection replacement, then verify replay.
- Delete/corrupt projections and append a partial tail; verify exact rebuild and preservation of complete lines.
- Scan generated data and dependencies to prove no database, object store, or durable non-Drive state exists.

Completion criteria:

- Canonical records are valid append-only JSONL and mutable JSON files are rebuildable projections.
- Recovery preserves every complete committed record without fabricating history.
- Persisted schemas contain only approved data with indefinite retention.

Implementation notes:

- None yet.

### TASK-005 — Implement locks, serialized mutation, and update checkpoints

Status: Pending

Requirements: REQ-F-011, REQ-F-012, REQ-F-015, REQ-F-021, REQ-F-030, REQ-F-033, REQ-NF-004, REQ-NF-010, REQ-NF-016

Design: DES-008, DES-012

Dependencies: TASK-003, TASK-004

Expected file or component changes:

- `src/worker/locks/**` — per-user/global locks, ownership, heartbeat, timeout, and stale recovery.
- `src/worker/updates/repository.ts`, `state-machine.ts` — checkpoint persistence and transitions.
- `tests/integration/concurrency/**` — ordering, contention, duplicate, and recovery tests.

Steps:

1. Hold a stable per-user lock for each complete turn and the global mutation lock only for durable mutations.
2. Enforce per-user-before-global order; export acquires only global.
3. Add bounded acquisition and stale recovery that proves the former owner is gone.
4. Implement `received`, `prompt_saved`, `model_complete`, `delivery_complete`, and `failed`.
5. Return terminal duplicates immediately and resume nonterminal stages without repeating completed effects.
6. Allow only the first durably completed assistant result to advance to delivery.

Verification:

- Test invalid lock order, contention, termination, stale ownership, and timeout.
- Deliver duplicates concurrently and after each checkpoint; assert one prompt and at most one generated reply.
- Run 10 simultaneous users plus repeated same-user messages; assert cross-user progress, per-user order, and valid JSONL.

Completion criteria:

- Same-user operations serialize, different users run concurrently, and all Drive mutations serialize.
- Redelivery resumes without duplicate prompt or delivery effects.
- Lock failure never bypasses serialization.

Implementation notes:

- None yet.

### TASK-006 — Implement user, conversation, message, and command services

Status: Pending

Requirements: REQ-F-003, REQ-F-004, REQ-F-005, REQ-F-006, REQ-F-010, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-022, REQ-NF-009, REQ-NF-014

Design: DES-013

Dependencies: TASK-004, TASK-005

Expected file or component changes:

- `src/worker/users/**`, `conversations/**`, `messages/**` — domain events, projections, lifecycle, and context.
- `src/worker/commands/**` — persisted deterministic `/start`, `/help`, and `/new`.
- `tests/unit/worker/domain/**`, `tests/integration/worker/domain/**` — lifecycle and privacy tests.

Steps:

1. Store only decimal Telegram user ID, nullable username/language code, immutable first-seen, and latest last-seen.
2. Create the first active conversation automatically and rebuild its pointer from events.
3. Make `/new` archive the current conversation and create a new empty active conversation atomically.
4. Build context from the configured system prompt and at most the latest 20 complete pairs.
5. Apply the latest-message language policy without persisting a new inferred profile field.
6. Persist deterministic command replies and delivery state without calling the model.

Verification:

- Test first/repeated contact, missing optional fields, first-seen immutability, and last-seen advancement.
- Test missing conversation, repeated `/new`, 0/1/20/21+ pairs, and archived-history exclusion.
- Verify prohibited Telegram fields and unsupported content never enter domain events.
- Verify deterministic commands do not invoke the model double.

Completion criteria:

- One active conversation exists per user and `/new` creates a clean boundary.
- Context is isolated and limited to 20 recent pairs.
- Persisted user profiles contain exactly the approved attributes.

Implementation notes:

- None yet.

### TASK-007 — Implement DeepSeek, retry policy, and usage accounting

Status: Pending

Requirements: REQ-F-007, REQ-F-008, REQ-F-009, REQ-F-010, REQ-F-014, REQ-F-018, REQ-F-032, REQ-F-034, REQ-NF-010, REQ-NF-011, REQ-NF-014

Design: DES-014, DES-015, DES-016, DES-017

Dependencies: TASK-001, TASK-002, TASK-004, TASK-006

Expected file or component changes:

- `src/worker/model/client.ts`, `deepseek.ts` — neutral contract and DeepSeek adapter.
- `src/worker/model/retry.ts`, `usage.ts` — retry/deadline policy and decimal cost estimates.
- `tests/unit/worker/model/**`, `tests/contracts/deepseek/**` — request, parsing, retry, and cost tests.

Steps:

1. Build validated requests from the system prompt and active context.
2. Use `deepseek-v4-pro`, non-streaming generation, configured thinking, `medium` effort, and an abort signal.
3. Return only validated non-empty final content and optional request/usage metadata; discard reasoning fields.
4. Retry only approved transient failures, at most twice after the initial attempt, with bounded jitter and deadline reserve.
5. Persist exact usage and applied price snapshots; calculate decimal estimates only when inputs exist.

Verification:

- Test valid, empty, malformed, reasoning-bearing, missing-usage, and provider-error responses.
- Assert the exact approved model/settings and no streaming.
- Prove deterministic failures are not retried and transient failures receive no third retry.
- Test exact arithmetic and unavailable usage/pricing cases.

Completion criteria:

- Only final content leaves the adapter; hidden reasoning and raw errors never do.
- Retry behavior is bounded and deadline-aware.
- Usage/cost values are accurate or explicitly unavailable.

Implementation notes:

- None yet.

### TASK-008 — Implement Telegram webhook, transport, and turn orchestration

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-003, REQ-F-010, REQ-F-011, REQ-F-013, REQ-F-014, REQ-F-015, REQ-F-017, REQ-F-018, REQ-F-033, REQ-NF-007, REQ-NF-009, REQ-NF-010, REQ-NF-014

Design: DES-002, DES-010, DES-011, DES-016

Dependencies: TASK-003, TASK-005, TASK-006, TASK-007

Expected file or component changes:

- `src/app/api/telegram/webhook/route.ts`, `src/server/telegram/input.ts` — POST-only secret-validated boundary and minimal input.
- `src/worker/telegram/client.ts` — typing, formatting, chunking, fallback, and delivery.
- `src/worker/orchestration/telegram-turn.ts` — checkpoints, persistence, model, delivery, and failures.
- `tests/contracts/telegram/**`, `tests/integration/telegram-turn/**` — supported, ignored, duplicate, resume, and error paths.

Steps:

1. Validate the webhook secret before JSON parsing; accept only private non-edited text and approved commands.
2. Drop raw updates and first/last names before Sandbox transport.
3. Give deterministic private-chat guidance for unsupported content without persisting it; acknowledge and ignore other excluded updates.
4. Orchestrate the full turn with the per-user lock and short global mutation sections.
5. Send/refresh typing activity, then split complete output into valid Telegram messages.
6. Fall back from rejected Markdown to escaped/plain text without regenerating.
7. Map terminal/retryable outcomes to safe webhook responses and persist sanitized failures.

Verification:

- Test method, missing/wrong secret, malformed input, supported text/commands, excluded inputs, and duplicates.
- With mocked Telegram/DeepSeek, verify typing, language, exact chunk reconstruction, formatting fallback, bounded retries, and final-only output.
- Interrupt after prompt persistence and model completion; verify correct resume behavior.
- Inspect requests/files for prohibited personal data and secrets.

Completion criteria:

- Valid public private-chat text receives one ordered persisted final answer.
- Unsupported input never reaches the model or conversational storage.
- Duplicate and resumed updates obey checkpoint guarantees.

Implementation notes:

- None yet.

### TASK-009 — Implement dashboard and download authentication

Status: Pending

Requirements: REQ-F-023, REQ-F-024, REQ-F-025, REQ-F-029, REQ-NF-007, REQ-NF-008

Design: DES-003

Dependencies: TASK-001, TASK-002

Expected file or component changes:

- `src/server/auth/secret.ts`, `session.ts`, `guards.ts` — digest comparison, signed cookie, and route/download guards.
- `src/app/login/**`, `src/app/logout/route.ts` — login and same-origin logout.
- `tests/unit/server/auth/**`, `tests/integration/auth/**` — fail-closed behavior.

Steps:

1. Accept arbitrary non-empty dashboard/signing secrets without format restrictions.
2. Compare fixed-length keyed digests with constant-time equality.
3. Issue a signed 24-hour `__Host-telegram-agent-session` cookie with approved attributes.
4. Validate signature/expiry before protected work and expire it on same-origin logout.
5. Accept download authentication from a valid cookie or exactly one bearer secret.
6. Reject credentials in URLs/browser storage and missing, empty, malformed, or multiple credentials.

Verification:

- Test Unicode/non-UUID values, empty/missing secrets, wrong lengths, and tampered/expired cookies.
- Test valid/invalid/multiple bearer headers and cookie attributes.
- Verify values do not appear in URLs, HTML, logs, worker files, or Drive data.

Completion criteria:

- Anyone with the configured string can obtain a 24-hour browser session.
- Invalid authentication reveals no protected data.
- Logout invalidates browser access; bearer access applies only to download.

Implementation notes:

- None yet.

### TASK-010 — Implement read-only dashboard queries

Status: Pending

Requirements: REQ-F-026, REQ-F-027, REQ-F-028, REQ-F-032, REQ-F-033, REQ-NF-011, REQ-NF-014

Design: DES-018

Dependencies: TASK-003, TASK-004, TASK-009

Expected file or component changes:

- `src/worker/queries/**` — overview, users, conversations, messages, model runs, and errors.
- `src/server/dashboard/view-models.ts` — validated query inputs/responses.
- `tests/integration/queries/**` — ordering, history, search, pagination, and immutability.

Steps:

1. Implement every approved query command using projections where possible.
2. Scan partitions only for complete history or message text.
3. Validate search/page inputs and return deterministic 50-row pages across the whole result set.
4. Add case-insensitive applicable search, empty states, and beyond-range results.
5. Preserve unavailable usage/cost values.
6. Ensure queries receive no provider credentials and cannot mutate files.

Verification:

- Seed multi-month data and verify totals, sorting, pages, searches, histories, and empty states.
- Compare the Drive tree and hashes before/after queries.
- Test malformed parameters and unavailable usage/pricing.

Completion criteria:

- All approved categories are exposed through typed read-only operations.
- Search/paging is deterministic and introduces no application usage cap.

Implementation notes:

- None yet.

### TASK-011 — Build the accessible responsive dashboard

Status: Pending

Requirements: REQ-F-023, REQ-F-024, REQ-F-026, REQ-F-027, REQ-F-028, REQ-NF-008, REQ-NF-012, REQ-NF-013

Design: DES-002, DES-019

Dependencies: TASK-009, TASK-010

Expected file or component changes:

- `src/app/dashboard/**` — protected layout, overview, users, conversations/detail, messages, model runs, and errors.
- `src/components/dashboard/**` — semantic navigation, records, search, paging, and empty/error states.
- `src/app/globals.css` and styling configuration — responsive and WCAG 2.2 AA presentation.
- `tests/e2e/dashboard/**` — authenticated/read-only browser tests.

Steps:

1. Render protected Server Component pages and server-side query calls.
2. Add semantic landmarks, headings, labels, records, navigation, pagination, refresh, and visible focus.
3. Adapt dense data for 320 CSS pixels without page-level horizontal scrolling.
4. Render explicit sanitized empty/error states.
5. Exclude editing, deletion, charts, polling, websockets, push, and client data caches.
6. Apply no-store, anti-framing, and restrictive browser security headers.

Verification:

- Use Playwright for login, all views, conversation detail, search, pages, refresh, logout, and unauthenticated access.
- Run automated accessibility and keyboard-only checks on every page.
- Test 320-pixel and representative current desktop/mobile viewports.
- Confirm there is no dashboard mutation or realtime path.

Completion criteria:

- Authenticated users can inspect all approved data through a responsive read-only interface.
- Accessibility and responsiveness checks pass.
- Data updates appear only after navigation or manual refresh.

Implementation notes:

- None yet.

### TASK-012 — Implement consistent authenticated ZIP download

Status: Pending

Requirements: REQ-F-025, REQ-F-029, REQ-F-030, REQ-F-031, REQ-F-033, REQ-NF-007, REQ-NF-014, REQ-NF-016

Design: DES-020

Dependencies: TASK-003, TASK-004, TASK-005, TASK-009

Expected file or component changes:

- `src/worker/export/**` — mutation barrier, stable copy, ZIP creation, and cleanup.
- `src/app/api/download/route.ts` — authentication, stream bridge, headers, and disconnect/error cleanup.
- `tests/integration/export/**`, `tests/contracts/download/**` — consistency, exclusions, streaming, and authentication.

Steps:

1. Wait for pending writes and acquire only the global mutation lock.
2. Flush/validate data, copy exactly `data/` to non-Drive temporary storage, then release the lock.
3. ZIP the stable copy, excluding code, locks, request files, temporary ZIPs, and environment values.
4. Return only an archive path/metadata through the worker contract.
5. Stream with `sandbox.readFile()` and approved type, filename, and no-store headers.
6. Clean up after completion, failure, or disconnect; never return a partial success.

Verification:

- Export during queued writes and verify the snapshot boundary and resumed conversations.
- Parse all JSON/JSONL ZIP entries and compare with the point-in-time tree.
- Verify runtime/secrets/hidden reasoning are absent.
- Test cookie, bearer, invalid/multiple credentials, quota failure, interruption, cleanup, and no full buffering.

Completion criteria:

- Either authentication method downloads a consistent timestamped ZIP of all persisted application data.
- Invalid authentication or export failure returns no successful archive.
- Repeated downloads have no application-defined cap.

Implementation notes:

- None yet.

### TASK-013 — Add sanitized observability and health

Status: Pending

Requirements: REQ-F-014, REQ-F-018, REQ-F-025, REQ-F-032, REQ-NF-007, REQ-NF-009, REQ-NF-011

Design: DES-021

Dependencies: TASK-002, TASK-003, TASK-004, TASK-007, TASK-008

Expected file or component changes:

- `src/shared/logger.ts`, `src/worker/errors/**` — redacted structured logs and durable errors.
- `src/app/api/health/route.ts` — safe, side-effect-free readiness.
- `tests/unit/observability/**`, `tests/integration/observability/**` — correlation and exclusion tests.

Steps:

1. Propagate one public-request correlation ID through commands, events, model runs, delivery, and logs.
2. Record only approved stage, duration, lifecycle, lock, write, retry, archive, and recovery metadata.
3. Persist sanitized failures for dashboard queries.
4. Return only `ready|degraded` and safe component states from health without creating a Drive.
5. Redact before ephemeral or durable serialization.

Verification:

- Trace successful/resumed turns, provider/delivery failures, recovery, queries, and export.
- Inject all prohibited secret/raw/reasoning fields and verify absence from logs and files.
- Call health in ready/degraded configurations and verify no Drive creation or internal details.

Completion criteria:

- Major operations are safely correlated and durable failures are inspectable.
- Health is bounded, non-secret, and side-effect-free.

Implementation notes:

- None yet.

### TASK-014 — Complete unit and local filesystem integration verification

Status: Pending

Requirements: REQ-F-004, REQ-F-005, REQ-F-006, REQ-F-011, REQ-F-012, REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-019, REQ-F-020, REQ-F-021, REQ-F-022, REQ-F-032, REQ-F-034, REQ-NF-003, REQ-NF-004, REQ-NF-005, REQ-NF-006, REQ-NF-009, REQ-NF-010, REQ-NF-011, REQ-NF-014, REQ-NF-016

Design: DES-007, DES-008, DES-009, DES-012, DES-013, DES-014, DES-017, DES-022, DES-024

Dependencies: TASK-004, TASK-005, TASK-006, TASK-007, TASK-012, TASK-013

Expected file or component changes:

- `tests/helpers/filesystem/**` — isolated roots, crash injection, clocks, and fixtures.
- `tests/integration/persistence/**`, `concurrency/**`, `worker/**`, `export/**` — cross-module local verification.
- Test configuration and coverage rules — reproducible offline suites.

Steps:

1. Run worker services through the same filesystem interface used on the Drive.
2. Verify durability ordering, atomic state, tail recovery, rebuild, rotation, and retention.
3. Exercise 10 concurrent conversations with repeated same-user updates and concurrent export.
4. Exercise every checkpoint and external failure boundary.
5. Validate every JSON/JSONL/ZIP artifact and scan prohibited fields.
6. Replace model, Telegram, and capability adapters with doubles to prove isolation.

Verification:

- Run `pnpm test:unit` and `pnpm test:integration`.
- Repeat the deterministic concurrency suite.
- Confirm coverage of every persistence transition, checkpoint, recovery branch, and redaction boundary.

Completion criteria:

- Local tests prove integrity, recovery, ordering, isolation, idempotency, export consistency, privacy, and modularity.
- Ordinary verification requires no live service or database.

Implementation notes:

- None yet.

### TASK-015 — Complete contract, browser, accessibility, and security verification

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-003, REQ-F-007, REQ-F-008, REQ-F-009, REQ-F-010, REQ-F-013, REQ-F-014, REQ-F-015, REQ-F-023, REQ-F-024, REQ-F-025, REQ-F-026, REQ-F-027, REQ-F-028, REQ-F-029, REQ-F-030, REQ-F-031, REQ-F-033, REQ-NF-007, REQ-NF-008, REQ-NF-010, REQ-NF-012, REQ-NF-013, REQ-NF-014

Design: DES-002, DES-003, DES-004, DES-005, DES-006, DES-010, DES-011, DES-015, DES-016, DES-018, DES-019, DES-020, DES-021, DES-022

Dependencies: TASK-008, TASK-011, TASK-012, TASK-013, TASK-014

Expected file or component changes:

- `tests/contracts/**` — Sandbox, Telegram, DeepSeek, and download boundaries.
- `tests/e2e/**`, `playwright.config.*` — authenticated, responsive, accessible browser stories.
- Security-header and bundle-inspection checks — browser/deployment boundaries.

Steps:

1. Verify webhook-to-worker-to-model-to-Telegram with mocked services and local files.
2. Verify SDK arguments, bootstrap, secrets, cleanup, errors, and streaming with controller mocks.
3. Verify auth, dashboard, search/paging, refresh, logout, bearer download, and read-only behavior.
4. Verify 320-pixel layout, keyboard/focus, accessible names/semantics, and WCAG 2.2 AA.
5. Inspect bundles/responses for secrets, unsafe caching/framing, future tools, and mutation endpoints.

Verification:

- Run `pnpm test:contracts`, `pnpm test:e2e`, accessibility/security checks, and `pnpm build`.
- Inspect client/server bundle boundaries.

Completion criteria:

- Mocked end-to-end behavior satisfies approved Telegram, model, authentication, dashboard, and export contracts.
- Accessibility, responsiveness, and security-boundary checks pass without adding excluded restrictions.

Implementation notes:

- None yet.

### TASK-016 — Document and verify Vercel Preview operations

Status: Pending

Requirements: REQ-F-007, REQ-F-014, REQ-F-019, REQ-F-022, REQ-F-025, REQ-F-029, REQ-F-030, REQ-F-031, REQ-NF-001, REQ-NF-002, REQ-NF-003, REQ-NF-007, REQ-NF-015, REQ-NF-016

Design: DES-023

Dependencies: TASK-003, TASK-012, TASK-015

Expected file or component changes:

- `docs/deployment.md`, `docs/operations.md`, `docs/rollback.md` — OIDC, `sin1`, variables, quotas, recovery, webhook, and non-destructive rollback.
- `scripts/verify-preview.*`, `tests/live-preview/**` — explicitly authorized real-resource checks.

Steps:

1. Document one named `sin1` Drive/Sandbox and automatic production/local pulled OIDC.
2. Document variables, Preview/Production separation, and webhook registration last.
3. Require explicit authorization and exact test resource names for live checks.
4. Verify stop/resume persistence, one writer, region/mount, lock/fsync/rename, streaming, and Hobby timeouts.
5. Block rollout if real Drive semantics do not satisfy the design.
6. Document rollback that preserves the Drive and never imports an archive.

Verification:

- Check runbook links/commands without secret values.
- Run `pnpm test:live-preview` only in an authorized Preview project.
- Stop/resume or replace the Sandbox and verify retained data/projections/downloads.
- Inspect `sin1`, mount, OIDC, no port, and no database/storage integration.

Completion criteria:

- An operator can deploy, validate, register/disable the webhook, diagnose failures, download data, and roll back safely.
- Live evidence confirms required Drive semantics before Production traffic.
- Ordinary tests never create or delete live resources.

Implementation notes:

- None yet.

### TASK-017 — Execute final acceptance and scope audit

Status: Pending

Requirements: REQ-F-001, REQ-F-002, REQ-F-003, REQ-F-004, REQ-F-005, REQ-F-006, REQ-F-007, REQ-F-008, REQ-F-009, REQ-F-010, REQ-F-011, REQ-F-012, REQ-F-013, REQ-F-014, REQ-F-015, REQ-F-016, REQ-F-017, REQ-F-018, REQ-F-019, REQ-F-020, REQ-F-021, REQ-F-022, REQ-F-023, REQ-F-024, REQ-F-025, REQ-F-026, REQ-F-027, REQ-F-028, REQ-F-029, REQ-F-030, REQ-F-031, REQ-F-032, REQ-F-033, REQ-F-034, REQ-NF-001, REQ-NF-002, REQ-NF-003, REQ-NF-004, REQ-NF-005, REQ-NF-006, REQ-NF-007, REQ-NF-008, REQ-NF-009, REQ-NF-010, REQ-NF-011, REQ-NF-012, REQ-NF-013, REQ-NF-014, REQ-NF-015, REQ-NF-016

Design: DES-001, DES-002, DES-003, DES-004, DES-005, DES-006, DES-007, DES-008, DES-009, DES-010, DES-011, DES-012, DES-013, DES-014, DES-015, DES-016, DES-017, DES-018, DES-019, DES-020, DES-021, DES-022, DES-023, DES-024

Dependencies: TASK-016

Expected file or component changes:

- `docs/acceptance-evidence.md` — each acceptance criterion, executed verification, and result.
- `tasks.md` implementation notes — final evidence without changing approved intent.

Steps:

1. Run the complete static, unit, integration, contract, browser, accessibility, security, build, and authorized Preview sequence.
2. Map reproducible evidence to every acceptance criterion.
3. Audit source, dependencies, routes, resources, Drive data, logs, archives, and UI against every NOT-TO-DO.
4. Confirm every dependency task is Completed without substantive design deviation.
5. Remain Blocked rather than weaken a criterion or accept a failed external guarantee.

Verification:

- Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`, and `pnpm build`.
- Run `pnpm test:live-preview` only with explicit authorization.
- Review acceptance evidence against every `AC-*`, `NTD-*`, requirement, and design ID.

Completion criteria:

- Every acceptance criterion has passing reproducible evidence or this task remains Blocked with one precise cause.
- No excluded datastore, input mode, restriction, moderation, mutation UI, realtime feature, hidden reasoning, public Sandbox port, or future tool is present.
- The implementation is ready for user-controlled Production rollout.

Implementation notes:

- None yet.

## Coverage matrix

| Requirement or design ID | Implementing tasks |
|---|---|
| REQ-F-001 | TASK-008, TASK-015, TASK-017 |
| REQ-F-002 | TASK-008, TASK-015, TASK-017 |
| REQ-F-003 | TASK-006, TASK-008, TASK-015, TASK-017 |
| REQ-F-004 | TASK-006, TASK-014, TASK-017 |
| REQ-F-005 | TASK-006, TASK-014, TASK-017 |
| REQ-F-006 | TASK-006, TASK-014, TASK-017 |
| REQ-F-007 | TASK-007, TASK-015, TASK-016, TASK-017 |
| REQ-F-008 | TASK-001, TASK-007, TASK-015, TASK-017 |
| REQ-F-009 | TASK-001, TASK-007, TASK-015, TASK-017 |
| REQ-F-010 | TASK-006, TASK-007, TASK-008, TASK-015, TASK-017 |
| REQ-F-011 | TASK-005, TASK-008, TASK-014, TASK-017 |
| REQ-F-012 | TASK-003, TASK-005, TASK-014, TASK-017 |
| REQ-F-013 | TASK-008, TASK-015, TASK-017 |
| REQ-F-014 | TASK-003, TASK-007, TASK-008, TASK-013, TASK-015, TASK-016, TASK-017 |
| REQ-F-015 | TASK-005, TASK-008, TASK-014, TASK-015, TASK-017 |
| REQ-F-016 | TASK-004, TASK-006, TASK-014, TASK-017 |
| REQ-F-017 | TASK-004, TASK-006, TASK-008, TASK-014, TASK-017 |
| REQ-F-018 | TASK-002, TASK-004, TASK-006, TASK-007, TASK-008, TASK-013, TASK-014, TASK-017 |
| REQ-F-019 | TASK-004, TASK-014, TASK-016, TASK-017 |
| REQ-F-020 | TASK-004, TASK-014, TASK-017 |
| REQ-F-021 | TASK-004, TASK-005, TASK-014, TASK-017 |
| REQ-F-022 | TASK-004, TASK-006, TASK-014, TASK-016, TASK-017 |
| REQ-F-023 | TASK-009, TASK-011, TASK-015, TASK-017 |
| REQ-F-024 | TASK-009, TASK-011, TASK-015, TASK-017 |
| REQ-F-025 | TASK-002, TASK-003, TASK-009, TASK-012, TASK-013, TASK-015, TASK-016, TASK-017 |
| REQ-F-026 | TASK-010, TASK-011, TASK-015, TASK-017 |
| REQ-F-027 | TASK-010, TASK-011, TASK-015, TASK-017 |
| REQ-F-028 | TASK-010, TASK-011, TASK-015, TASK-017 |
| REQ-F-029 | TASK-009, TASK-012, TASK-015, TASK-016, TASK-017 |
| REQ-F-030 | TASK-005, TASK-012, TASK-015, TASK-016, TASK-017 |
| REQ-F-031 | TASK-012, TASK-015, TASK-016, TASK-017 |
| REQ-F-032 | TASK-007, TASK-010, TASK-013, TASK-014, TASK-017 |
| REQ-F-033 | TASK-001, TASK-003, TASK-005, TASK-008, TASK-010, TASK-012, TASK-015, TASK-017 |
| REQ-F-034 | TASK-002, TASK-007, TASK-014, TASK-017 |
| REQ-NF-001 | TASK-001, TASK-003, TASK-016, TASK-017 |
| REQ-NF-002 | TASK-001, TASK-003, TASK-016, TASK-017 |
| REQ-NF-003 | TASK-004, TASK-014, TASK-016, TASK-017 |
| REQ-NF-004 | TASK-005, TASK-014, TASK-017 |
| REQ-NF-005 | TASK-004, TASK-014, TASK-017 |
| REQ-NF-006 | TASK-004, TASK-014, TASK-017 |
| REQ-NF-007 | TASK-001, TASK-002, TASK-003, TASK-008, TASK-009, TASK-012, TASK-013, TASK-015, TASK-016, TASK-017 |
| REQ-NF-008 | TASK-009, TASK-011, TASK-015, TASK-017 |
| REQ-NF-009 | TASK-002, TASK-004, TASK-006, TASK-008, TASK-013, TASK-014, TASK-017 |
| REQ-NF-010 | TASK-005, TASK-007, TASK-008, TASK-014, TASK-015, TASK-017 |
| REQ-NF-011 | TASK-002, TASK-007, TASK-010, TASK-013, TASK-014, TASK-017 |
| REQ-NF-012 | TASK-011, TASK-015, TASK-017 |
| REQ-NF-013 | TASK-011, TASK-015, TASK-017 |
| REQ-NF-014 | TASK-001, TASK-002, TASK-003, TASK-006, TASK-007, TASK-008, TASK-010, TASK-012, TASK-014, TASK-015, TASK-017 |
| REQ-NF-015 | TASK-001, TASK-003, TASK-016, TASK-017 |
| REQ-NF-016 | TASK-005, TASK-012, TASK-014, TASK-016, TASK-017 |
| DES-001 | TASK-001, TASK-017 |
| DES-002 | TASK-008, TASK-011, TASK-015, TASK-017 |
| DES-003 | TASK-009, TASK-015, TASK-017 |
| DES-004 | TASK-003, TASK-015, TASK-017 |
| DES-005 | TASK-003, TASK-015, TASK-017 |
| DES-006 | TASK-003, TASK-015, TASK-017 |
| DES-007 | TASK-004, TASK-014, TASK-017 |
| DES-008 | TASK-005, TASK-014, TASK-017 |
| DES-009 | TASK-004, TASK-014, TASK-017 |
| DES-010 | TASK-008, TASK-015, TASK-017 |
| DES-011 | TASK-008, TASK-015, TASK-017 |
| DES-012 | TASK-005, TASK-014, TASK-017 |
| DES-013 | TASK-006, TASK-014, TASK-017 |
| DES-014 | TASK-002, TASK-007, TASK-014, TASK-017 |
| DES-015 | TASK-007, TASK-015, TASK-017 |
| DES-016 | TASK-007, TASK-008, TASK-015, TASK-017 |
| DES-017 | TASK-007, TASK-014, TASK-017 |
| DES-018 | TASK-010, TASK-015, TASK-017 |
| DES-019 | TASK-011, TASK-015, TASK-017 |
| DES-020 | TASK-012, TASK-015, TASK-017 |
| DES-021 | TASK-002, TASK-013, TASK-015, TASK-017 |
| DES-022 | TASK-014, TASK-015, TASK-017 |
| DES-023 | TASK-016, TASK-017 |
| DES-024 | TASK-002, TASK-014, TASK-017 |
