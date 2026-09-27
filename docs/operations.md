# Operations

## Health

`GET /api/health` returns only `ready` or `degraded` and safe component states. It validates configuration, including the Google Drive OAuth settings, and does not open Google Drive or create a Sandbox. A degraded result means required configuration is missing or invalid; it does not reveal names, regions, folder ids, or secret values.

## Dashboard

Open `/login` and submit the configured `DASHBOARD_SECRET`. The session cookie is `__Host-telegram-agent-session`, lasts 24 hours, and is limited to this host. Logout is a same-origin POST to `/logout`.

Pages are server-rendered and read-only. Search and pagination use the query string. Data changes appear after navigation or the Refresh link. There is no polling, websocket, or chart.

## Download

`GET /api/download` accepts the dashboard session cookie or exactly one `Authorization: Bearer <DASHBOARD_SECRET>` header. It waits for the global mutation lock, copies `data/`, and streams a ZIP. Runtime locks, worker files, and environment values are not in the archive. Failed exports return an error and delete the temporary archive.

Do not put the bearer secret in a URL, shell history, or log. Inject it through the request header.

## Quotas

The application does not add its own rate, storage, login, or concurrency caps. Vercel Hobby and Google Drive limits still apply. When those limits are hit, the request fails with a sanitized retryable or unavailable response and the last successfully uploaded files stay in the folder.

## Recovery

On each worker command, an empty scratch directory is filled from `data/` and `logs/worker/` in the Google Drive folder. An existing local manifest is left in place. Partial trailing JSONL lines can still be quarantined under `data/recovery/quarantine/`. Projections can be rebuilt from the append-only records. A stopped Sandbox can be replaced under the same name; the Google Drive folder remains the source of truth. Locks stay on the sandbox and are not uploaded. Do not create a second writer.

## Live Preview gate

Ordinary tests use a temporary local directory, an in-memory Drive fake, and mocked Telegram, DeepSeek, and Sandbox calls. `pnpm test:live-preview` is the only command intended to touch the real Google Drive folder, and only when all of the following are true:

- `TELEGRAM_AGENT_LIVE_PREVIEW=authorized`
- `SANDBOX_NAME` matches `telegram-agent-preview-*`
- `GOOGLE_DRIVE_FOLDER_ID` is `1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo`
- Google OAuth client id, secret, and refresh token are set
- `VERCEL_OIDC_TOKEN` was pulled for that Preview project
- the operator has accepted that the command may resume the named test Sandbox and write a marker into the folder

The live check must show `sin1`, no public port, and the marker surviving sandbox stop and resume by hydrating from the folder.

## Failure diagnosis

Structured logs carry a correlation ID, stage, duration, and safe error code. Worker logs are appended to `logs/worker/YYYY-MM.jsonl` in the folder. Controller logs are one file each under `logs/controller/`. Dashboard Errors shows the same sanitized failure records stored in `data/`. Logs must not contain secrets, raw webhook bodies, hidden reasoning, or provider response bodies.
