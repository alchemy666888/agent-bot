# Acceptance evidence

Local verification is recorded in `specs/telegram-agent/tasks.md`. This file maps that evidence to the acceptance criteria. Live `sin1` Drive evidence is not available until an operator authorizes `pnpm test:live-preview`.

| Criterion             | Evidence                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-001 through AC-010 | Unit, integration, and contract tests for turns, DeepSeek settings, ordering, idempotency, profiles, append/recovery, and redaction.         |
| AC-011                | Auth unit tests plus Playwright login, tampered cookie, logout, and unauthenticated redirect.                                                |
| AC-012                | Playwright coverage of overview, users, conversations, conversation detail, messages, usage, errors, search, pagination, and manual refresh. |
| AC-013                | Export integration tests and Playwright cookie/bearer ZIP checks.                                                                            |
| AC-014                | Cost unit tests and dashboard rendering of a stored estimate and an unavailable estimate.                                                    |
| AC-015                | Source and dependency scan shows no application quota, throttle, or lockout.                                                                 |
| AC-016                | Model and Telegram doubles in integration tests; capability module is inactive and unused by the worker.                                     |
| AC-017                | Controller unit tests require `sin1` and one mount. Live region evidence is outstanding.                                                     |
| AC-018                | Playwright axe checks and 320, 390, and 1280 CSS-pixel layouts.                                                                              |
| AC-019                | Controller mismatch tests refuse a second writer. Live stop/resume evidence is outstanding.                                                  |

NOT-TO-DO audit:

- NTD-001: dependencies and source do not include a database or object store.
- NTD-002: durable worker writes stay under the configured data root; local tests use a temporary directory and Vercel ignores `TELEGRAM_AGENT_LOCAL_ROOT`.
- NTD-003: webhook input accepts private text and commands only.
- NTD-004: the capability interface is disabled and has no adapter.
- NTD-005: no moderation or blocking controls.
- NTD-006: no application rate limit, quota, CAPTCHA, or lockout.
- NTD-007: dashboard actions are navigation, search, refresh, logout, and download.
- NTD-008: `/start` has no privacy or retention notice.
- NTD-009 and NTD-012: redaction tests and filesystem scans reject names, secrets, and hidden reasoning.
- NTD-010: dashboard pages are server-rendered and do not poll or chart.
- NTD-011: one named Sandbox is the writer; tests do not create a writable snapshot.
- NTD-013: specification files were not rewritten; only task status and notes change during implementation.
