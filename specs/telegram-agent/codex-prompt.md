# Codex implementation prompt: Telegram Agent

Status: Approved

## Assignment

Implement the approved specification in `specs/telegram-agent/` without expanding, weakening, or redesigning it. This is a greenfield Next.js 16 application for a public Telegram conversational assistant using DeepSeek V4 Pro, external PostgreSQL, and Vercel Hobby.

Complete `TASK-001` through `TASK-016` in dependency order. Produce application code, migrations, tests, configuration examples, and documentation, but do not deploy, run a migration against a user database, register a live Telegram webhook, or call a live DeepSeek API unless the user separately authorizes that external action and supplies the required configuration.

## Source of truth

Read these files completely before modifying code:

1. `specs/telegram-agent/requirements.md`
2. `specs/telegram-agent/design.md`
3. `specs/telegram-agent/tasks.md`

Verify that all three say `Status: Approved`. If any file is not approved, stop and ask one precise question.

Precedence is requirements, then design, then tasks. Treat a conflict, missing value, or implementation need that cannot be resolved without changing approved intent as a stop condition; do not silently choose an interpretation.

## Preflight

1. Read every applicable `AGENTS.md`, repository instruction, and project document before editing.
2. Inspect `git status --short --branch` and the complete relevant file layout. Preserve all unrelated or pre-existing user changes.
3. Confirm this remains a greenfield implementation with only the approved specification as the existing project content. If application code or conflicting repository conventions now exist, inspect them and stop if they invalidate the approved design.
4. Re-validate task dependencies, requirements/design coverage, and the 16 tasks' `Pending` statuses.
5. Confirm Node.js 24 and pnpm are available. Record tool/version evidence in the active task's implementation notes.
6. Never read, print, copy, or commit real credential values. Use `.env.example` names and test-only seeded values.
7. Establish the baseline verification state before implementation. If a required tool is unavailable or installing dependencies requires authority not already granted, mark the active task `Blocked` and ask one precise question.

## Execution

Execute tasks in numerical dependency order. Do not skip ahead merely because a later task is convenient.

For each task:

1. Confirm every listed dependency is `Completed`.
2. Change only that task's status in `tasks.md` from `Pending` to `In Progress` before changing implementation files.
3. Implement only the approved task scope, following the exact paths/components or an equivalent path required by established repository conventions. If an equivalent path changes a substantive boundary, stop.
4. Add or update the task's tests as part of the implementation; do not defer essential verification without a documented task dependency.
5. Run every verification listed for the task. Use an ephemeral PostgreSQL instance and mocked Telegram/DeepSeek servers for ordinary automated tests.
6. Record concise implementation notes and exact verification evidence under that task in `tasks.md`.
7. Change the task status to `Completed` only after every completion criterion and verification succeeds. Otherwise use `Blocked` and state the evidence.

Implementation rules:

- Use `apply_patch` for intentional source edits and preserve unrelated changes.
- Maintain strict TypeScript and the approved module boundaries: Telegram transport, conversation orchestration, model integration, persistence, dashboard queries/UI, authentication, and observability.
- Use Next.js 16 App Router, Node.js 24, pnpm, Tailwind CSS, Drizzle ORM, `node-postgres`, grammY, native `fetch`, Vitest, real ephemeral PostgreSQL integration tests, Playwright, and accessibility/security verification as approved.
- Keep the Telegram webhook synchronous, POST-only, secret-validated before JSON parsing, idempotent by Telegram update ID, and serialized per user with a dedicated PostgreSQL session advisory lock.
- Use persisted checkpoints exactly as designed. Never call DeepSeek before the prompt checkpoint is durable, and never regenerate after a reusable `model_complete` response exists.
- Fix the model identifier to `deepseek-v4-pro`. Apply the configured thinking mode and validated reasoning effort. Immediately discard `reasoning_content`; never return, persist, fixture-snapshot, or log it.
- Persist only approved Telegram user fields. Never persist raw Telegram updates, first/last names, unsupported content, hidden reasoning, credentials, authorization values, cookies, or connection strings.
- Implement the stateless 24-hour HMAC dashboard session, fail-closed guards, read-only Server Component dashboard, no-store behavior, search, and 50-row pagination exactly as designed.
- Do not fix a Vercel Function region in source. Document and verify that the operator must select one supported Asian region nearest the external PostgreSQL database through Vercel project settings or the deployment CLI.
- Keep migrations explicit, additive, and absent from build/startup/request paths.
- Keep live provider tests opt-in. No ordinary verification may incur DeepSeek charges, message a real Telegram user, mutate an external database, change Vercel settings, deploy, or register/remove a live webhook.
- Run formatting, linting, type checking, relevant tests, and production build throughout implementation rather than waiting until the final task.

Only task statuses and implementation notes in the approved `tasks.md` may change during implementation. Do not edit approved requirements, design content, task intent, dependencies, verification, completion criteria, or the approved status headers. Reopen the SDD workflow for any substantive specification change.

## Stop conditions

Mark the active task `Blocked`, record concise evidence in its implementation notes, and ask one focused question before proceeding when:

- required information is missing, ambiguous, or contradicts another approved statement;
- the approved documents conflict with verified repository, provider, framework, or plan constraints;
- implementation requires a substantive requirements, architecture, schema, security, API, dependency, or task change;
- work would exceed scope or violate any NOT-TO-DO;
- a needed file contains overlapping user changes that cannot be preserved safely;
- a destructive or externally consequential action requires new authorization;
- real credentials, external database access, Vercel project mutation, production migration, webhook registration, deployment, or live paid API usage would be required;
- dependency installation, Docker/ephemeral PostgreSQL, browser execution, or another required verification is unavailable;
- a verification command fails and cannot be corrected within the active task's approved intent;
- secrets or prohibited data are discovered in code, fixtures, output, logs, persistence, or client bundles.

Do not invent requirements, bypass verification, silently choose a new design, weaken a test, remove a failure assertion, or mark partial work `Completed`.

## NOT-TO-DOs

- Do not implement Telegram groups, channels, inline mode, edited-message processing, rich-message streaming, or media/file/voice inputs.
- Do not implement web search, MCP, function calling, code execution, agent tools, scheduled actions, or tool scaffolding beyond the approved provider-neutral model boundary.
- Do not add a separate moderation API, keyword filter, administrator user blocking, or safety database.
- Do not add application rate limits, quotas, traffic/storage caps, login throttling, CAPTCHA, IP restrictions, or account lockouts.
- Do not add user-facing deletion, retention expiry, dashboard edit/delete/export actions, database deletion services, or cleanup jobs.
- Do not add a `/start` privacy or retention notice.
- Do not persist Telegram first names, last names, unsupported-input content, raw updates, hidden model reasoning, credentials, authorization headers, cookies, connection strings, or raw provider errors.
- Do not add dashboard polling, live updates, push notifications, charts, a dark/theme switcher, or another UI component framework.
- Do not provision or require a PostgreSQL vendor; use the operator-supplied standards-compatible connection.
- Do not add Redis, a cache, queue, cron worker, realtime service, Vercel Workflow, or another persistent datastore.
- Do not replace grammY, Drizzle/`node-postgres`, native DeepSeek `fetch`, stateless HMAC sessions, or the synchronous webhook architecture without reopening SDD.
- Do not hard-code a Vercel Function region or default silently to a non-Asian region.
- Do not run migrations automatically during build, startup, or requests, and do not implement destructive automatic down-migrations.
- Do not deploy or perform any live external mutation solely because implementation succeeds.

## Completion report

After all 16 tasks are `Completed`, provide a concise report containing:

- completed task IDs and the major files/components created;
- the final architecture and scope delivered, including explicit confirmation that excluded features were not added;
- exact commands run and their pass/fail results for clean install, format, lint, type checking, unit, contract, integration, concurrency, E2E, accessibility, security, migration, and production build verification;
- evidence that 10 simultaneous conversations remained isolated and same-user messages stayed ordered;
- evidence that duplicate Telegram updates produced at most one persisted/delivered assistant reply;
- evidence that seeded secrets, first/last names, raw payloads, and hidden reasoning were absent from client bundles, logs, persistence, and responses;
- any approved-equivalent path choices or non-substantive deviations, with reasons;
- external actions intentionally not performed, including production migration, deployment, Vercel region selection, live DeepSeek calls, and live Telegram webhook mutation;
- remaining blockers, risks, or operator steps, especially environment configuration, selecting the nearest supported Asian Vercel region, running the explicit migration, deployment, health validation, and webhook registration.

If any task remains `Blocked`, do not present the project as complete. Report the blocking task, evidence, and the single decision needed next.
