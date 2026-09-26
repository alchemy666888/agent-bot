# Operations

## Health

`GET /api/health` returns only `ready` or `degraded` and safe component states. It validates configuration and does not create or resume a Sandbox or Drive. A degraded result means required configuration is missing or invalid; it does not reveal names, regions, or secret values.

## Dashboard

Open `/login` and submit the configured `DASHBOARD_SECRET`. The session cookie is `__Host-telegram-agent-session`, lasts 24 hours, and is limited to this host. Logout is a same-origin POST to `/logout`.

Pages are server-rendered and read-only. Search and pagination use the query string. Data changes appear after navigation or the Refresh link. There is no polling, websocket, or chart.

## Download

`GET /api/download` accepts the dashboard session cookie or exactly one `Authorization: Bearer <DASHBOARD_SECRET>` header. It waits for the global mutation lock, copies `data/`, and streams a ZIP. Runtime locks, worker files, and environment values are not in the archive. Failed exports return an error and delete the temporary archive.

Do not put the bearer secret in a URL, shell history, or log. Inject it through the request header.

## Quotas

The application does not add its own rate, storage, login, or concurrency caps. Vercel Hobby and Drive limits still apply. When those limits are hit, the request fails with a sanitized retryable or unavailable response and committed files stay in place.

## Recovery

On Sandbox create or resume, the worker validates the manifest and JSONL tails. Only a partial trailing line is quarantined under `data/recovery/quarantine/`. Projections can be rebuilt from the append-only records. A stopped Sandbox can be replaced under the same name; the Drive remains the source of truth. Do not create a second writer or a writable snapshot.

## Live Preview gate

Ordinary tests use a temporary local directory and mocked Telegram, DeepSeek, and Sandbox calls. `pnpm test:live-preview` is the only command intended to touch a real Drive, and only when all of the following are true:

- `TELEGRAM_AGENT_LIVE_PREVIEW=authorized`
- `SANDBOX_DRIVE_NAME` and `SANDBOX_NAME` match `telegram-agent-preview-*`
- `VERCEL_OIDC_TOKEN` was pulled for that Preview project
- the operator has accepted that the command may resume the named test Sandbox

The live check must show `sin1`, one `/workspace` mount, no public port, persistence across stop/resume, one writer, and streamed download. If the real Drive cannot provide the locking, fsync, or rename behavior the design requires, stop the rollout.

## Failure diagnosis

Structured logs carry a correlation ID, stage, duration, and safe error code. Dashboard Errors shows the same sanitized failure records. Logs must not contain secrets, raw webhook bodies, hidden reasoning, or provider response bodies.
