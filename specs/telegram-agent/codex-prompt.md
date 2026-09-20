# Codex implementation prompt: Telegram Agent on Vercel Sandbox Drive

Status: Approved

## Assignment

Implement the approved specification in `specs/telegram-agent/` without expanding, weakening, or redesigning it.

This is a greenfield Next.js application for a public, general-purpose Telegram conversational assistant. It uses the DeepSeek API model identifier `deepseek-v4-pro`, runs on Vercel Hobby, and persists durable application data only as ordinary files on one Vercel Sandbox Drive mounted into one named private Sandbox in Singapore (`sin1`).

The system also includes a secret-protected, read-only web dashboard and an authenticated API that streams a consistent ZIP download of persisted data. PostgreSQL, SQLite, object storage, and every other database or second durable store are prohibited.

Complete the approved tasks in dependency order. Do not begin by implementing an alternative architecture or a reduced subset.

## Source of truth

Read these files completely before modifying application code:

1. `specs/telegram-agent/requirements.md`
2. `specs/telegram-agent/design.md`
3. `specs/telegram-agent/tasks.md`

Verify that all three say `Status: Approved`. Confirm that:

- `requirements.md` defines the product scope, acceptance criteria, edge cases, risks, and NOT-TO-DOs;
- `design.md` defines the approved components, file schemas, APIs, flows, security model, testing, rollout, and rollback;
- `tasks.md` contains 17 Pending tasks and the complete requirement/design coverage matrix.

If any source document is missing, not approved, contradictory, or materially incompatible with the repository or current platform behavior, stop before modifying application code. Mark the applicable task `Blocked` and ask one precise question.

The three approved documents outrank this implementation prompt when more detail is needed. This prompt governs execution discipline; it does not replace their technical content.

## Preflight

Before implementation:

1. Read repository-level and directory-level instructions, including any applicable `AGENTS.md`.
2. Inspect the worktree status and existing files without discarding, overwriting, or reformatting unrelated user changes.
3. Confirm whether the repository remains greenfield or contains work created since this specification was approved.
4. Compare any existing manifests, configuration, modules, and tests with the approved design.
5. Confirm that implementation can use the approved standard filenames:
   - `specs/telegram-agent/requirements.md`
   - `specs/telegram-agent/design.md`
   - `specs/telegram-agent/tasks.md`
   - `specs/telegram-agent/codex-prompt.md`
6. Establish the baseline verification that is possible before changes and record any pre-existing failures separately.
7. Confirm that no database, ORM, object-store integration, public Sandbox service, or conflicting persistence layer has already been introduced.
8. Never print, commit, copy into source, or persist secret values. Use environment-variable names and test fixtures only.

Do not install dependencies, create live Vercel resources, register a Telegram webhook, or make externally consequential changes merely to complete preflight. Those actions occur only within the relevant task and authorization boundary.

## Execution

Execute `TASK-001` through `TASK-017` in the dependency order specified by `tasks.md`.

For each task:

1. Confirm every listed dependency is `Completed`.
2. Change only that task's status from `Pending` to `In Progress`.
3. Re-read its linked requirements, design decisions, expected changes, steps, verification, and completion criteria.
4. Implement only its approved scope while preserving repository conventions and unrelated user changes.
5. Run every verification listed for the task, including negative and failure-path checks.
6. Record concise implementation notes in that task:
   - files or components changed;
   - key implementation decisions that directly apply the approved design;
   - commands or checks executed;
   - pass/fail results and relevant evidence;
   - any explicitly authorized live-resource verification.
7. Change the task to `Completed` only when every verification and completion criterion passes.
8. If completion is impossible, change the task to `Blocked`, record the exact cause and completed evidence, and ask one focused question.

During implementation:

- Keep `requirements.md` and `design.md` unchanged.
- In `tasks.md`, modify only task statuses and implementation notes.
- Keep `codex-prompt.md` unchanged.
- Preserve stable IDs, task wording, dependencies, verification, completion criteria, and the coverage matrix.
- Reopen the SDD workflow before making any substantive requirements, design, task-intent, or scope change.
- Use the filesystem abstraction, provider interfaces, and contract boundaries approved in the design.
- Prefer local mocks and temporary local filesystem integration tests for ordinary development.
- Keep real Vercel Preview checks explicitly gated and operator-authorized.
- Do not silently skip verification because an external service is unavailable; mark the relevant task Blocked when its completion requires that evidence.
- Do not mark a task Completed based only on code inspection when its specified tests or observable checks have not passed.

## Required architecture invariants

Maintain these invariants throughout all tasks:

- Durable application data exists only beneath `/workspace/telegram-agent/data` on the one named Sandbox Drive.
- The Drive and its writer Sandbox are both in `sin1`.
- One named Sandbox is the sole read-write attachment; no competing writer or writable snapshot is created.
- The Sandbox exposes no public port. Next.js communicates through the authenticated Vercel Sandbox SDK and private worker commands.
- Production Vercel authentication uses managed OIDC; local development uses the pulled `VERCEL_OIDC_TOKEN`.
- Worker code, request/response files, lock files, generated ZIPs, and temporary files are outside the downloaded durable `data/` tree.
- Canonical records are append-only monthly JSONL; small JSON state files are derived and rebuildable.
- Events are committed and synced before atomic projection replacement.
- A per-user lock covers each complete turn. The global mutation lock covers only durable mutation or export snapshot copying.
- Lock order is per-user then global; export acquires only global.
- Telegram `update_id` checkpoints make redelivery idempotent and resumable.
- Different users may run concurrently; one user's messages remain ordered.
- Raw Telegram updates, first/last names, unsupported-input content, secrets, cookies, hidden reasoning, and raw provider error bodies are never persisted.
- DeepSeek calls use `deepseek-v4-pro`, non-streamed generation, configurable thinking defaulting enabled, and medium reasoning effort.
- Only final assistant content is delivered or stored; hidden reasoning is discarded.
- Dashboard pages are authenticated, server-rendered, no-store, read-only, manually refreshed, responsive, and accessible.
- ZIP export waits for pending writes, snapshots a consistent data tree, excludes runtime/secrets, and streams without full Next.js buffering.
- No application-defined quota, throttle, login lockout, traffic cap, storage cap, download cap, or concurrency cap is introduced.

## Authorization boundaries

Local source changes and local tests are authorized by this implementation handoff after all four SDD documents are approved.

The following require explicit operator authorization at the time they are attempted:

- creating, deleting, replacing, attaching, or otherwise mutating live Vercel Sandbox or Drive resources;
- running the gated live Vercel Preview suite;
- changing Vercel project settings or environment variables;
- registering, replacing, or removing the production Telegram webhook;
- deploying or promoting a Production release;
- any action that may affect retained Drive files or external service billing.

Use exact named test resources for authorized Preview checks. Never delete, recreate, move, overwrite, or import into the production Drive as part of testing or rollback.

## Verification policy

Run the verification required by each task. The full release sequence includes:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:contracts`
- `pnpm test:e2e`
- `pnpm build`
- `pnpm test:live-preview` only when explicitly authorized and configured

Use mocked Telegram and DeepSeek endpoints and a temporary local filesystem for ordinary automated tests. Do not require PostgreSQL, SQLite, another database, or live external services for normal verification.

The final evidence must demonstrate:

- valid append-only files, atomic projections, recovery, and rebuild;
- 10 simultaneous conversations without making 10 a runtime limit;
- same-user order and cross-user isolation;
- duplicate-update idempotency and every resume checkpoint;
- final-answer-only DeepSeek behavior and bounded retry policy;
- Telegram typing, formatting fallback, and lossless chunking;
- arbitrary non-empty dashboard-secret support and fail-closed authentication;
- read-only dashboard search, pagination, manual refresh, accessibility, and 320-pixel responsiveness;
- consistent authenticated ZIP streaming during queued writes;
- secret, hidden-reasoning, and prohibited-field exclusion from source-visible output, logs, Drive files, and archives;
- actual `sin1` Drive/Sandbox persistence, one-writer, lock, sync, rename, resume, and streaming behavior before Production rollout.

Treat a failed check as a failure. Do not weaken assertions, remove tests, change acceptance criteria, or silently substitute a different platform/service to make verification pass.

## Stop conditions

Mark the active task `Blocked`, preserve completed work and evidence, and ask one focused question before proceeding when:

- required information is missing or ambiguous;
- the approved documents conflict with each other or verified repository constraints;
- implementation requires a substantive specification or task-intent change;
- work would exceed scope or violate a NOT-TO-DO;
- an approved platform capability is unavailable or behaves incompatibly with a required guarantee;
- a destructive or externally consequential action needs new authorization;
- secret values or live credentials are unavailable for an explicitly required live check;
- required verification cannot be executed or does not pass;
- real Drive behavior cannot demonstrate required locking, fsync, atomic rename, recovery, or single-writer semantics;
- a dependency task is not Completed;
- unrelated worktree changes overlap the required edit and cannot be preserved safely.

Do not invent requirements, silently redesign the system, change providers or persistence, omit a required test, or report partial work as complete.

## NOT-TO-DOs

- Do not implement or configure PostgreSQL, SQLite, another database, object storage, or a second persistent datastore.
- Do not store durable data in ordinary Vercel Function storage or outside the mounted Drive's approved data tree.
- Do not implement Telegram groups, channels, inline mode, edited-message processing, or non-text conversational inputs.
- Do not implement web search, MCP, function calling, code execution, scheduled actions, or other agent tools.
- Do not implement a separate moderation API, keyword filter, administrator blocking, or user restriction system.
- Do not add application-level rate limits, quotas, traffic caps, storage caps, login throttling, CAPTCHA, IP restrictions, account lockouts, or runtime conversation caps.
- Do not add user-facing deletion, retention expiry, archive import, or dashboard editing.
- Do not add a `/start` privacy or retention notice.
- Do not persist Telegram first names, last names, unsupported-input content, raw updates, hidden reasoning, credentials, authorization headers, cookies, or raw provider secrets.
- Do not add dashboard charts, polling, websockets, push updates, or live refresh.
- Do not create multiple concurrent Drive writers or writable Drive snapshots.
- Do not expose hidden DeepSeek reasoning anywhere.
- Do not expose a public Sandbox port or run a public service inside the Sandbox.
- Do not use an implementation shortcut that weakens event-first durability, atomic replacement, locking, idempotency, export consistency, authentication, or secret exclusion.
- Do not modify approved specification content. Only task statuses and implementation notes in `tasks.md` may change during implementation.

## Completion report

After all tasks are `Completed`, provide a concise final report containing:

1. completed task IDs;
2. principal files and components created or changed;
3. verification commands and outcomes;
4. authorized live Preview evidence, including region, persistence, single-writer, lifecycle, and streaming results;
5. confirmation that every acceptance criterion has evidence;
6. confirmation that every NOT-TO-DO was audited;
7. any deviations, residual risks, or external platform limitations;
8. the exact user-controlled steps still required for Production configuration, deployment, webhook registration, or rollback readiness.

If any task remains `Pending`, `In Progress`, or `Blocked`, do not call the implementation complete. Report its exact status and the next required decision or authorization.
