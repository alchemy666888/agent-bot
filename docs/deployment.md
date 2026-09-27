# Deployment

This application runs on Vercel Hobby. Durable logs and application data are ordinary files in Google Drive folder `1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo`. A named private Sandbox in `sin1` is the worker runtime. Its local files are a scratch copy. A file is committed only after it uploads to that folder. PostgreSQL, SQLite, object storage, and a Vercel Sandbox Drive are not used.

## Project setup

1. Create or link the Vercel project.
2. Select the Singapore Sandbox region. The controller always sends `region: "sin1"` and rejects any other returned region or a public route.
3. Configure the variables named in `.env.example` in the Vercel project. Do not commit values.
4. Production authentication uses Vercel managed OIDC. Do not store a long-lived Vercel access token for the approved workflow.
5. For local development, obtain `VERCEL_OIDC_TOKEN` with `vercel env pull`. Keep that file uncommitted.

Required variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `DEEPSEEK_API_KEY`
- `DASHBOARD_SECRET`
- `SESSION_SIGNING_SECRET`
- `APP_URL`
- `DEEPSEEK_INPUT_PRICE_PER_MILLION`
- `DEEPSEEK_OUTPUT_PRICE_PER_MILLION`
- `GOOGLE_DRIVE_FOLDER_ID` (`1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo`)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `SANDBOX_NAME`

Optional variables use the defaults in `src/server/config/index.ts`. If `SANDBOX_REGION` is set, it must be `sin1`.

`TELEGRAM_AGENT_LOCAL_ROOT` is a test-only filesystem switch for mocked worker commands. The server ignores it whenever `VERCEL` is set, so Preview and Production always sync the scratch directory with the Google Drive folder.

Create a Google Cloud OAuth client for the account that owns the folder. Authorize the scope `https://www.googleapis.com/auth/drive` once, and store the refresh token in `GOOGLE_REFRESH_TOKEN`. The application rejects any other folder id. Do not put the refresh token, client secret, or access token in a Drive file or log.

## Preview and Production

Use a Sandbox name that matches `telegram-agent-preview-*` for live checks. Those checks upload into the same Google Drive folder. Do not run them unless `TELEGRAM_AGENT_LIVE_PREVIEW=authorized`.

1. Deploy a Preview build.
2. Confirm health returns `ready` or a sanitized `degraded` state. It validates configuration and does not open Google Drive or create a Sandbox.
3. Run the local suites: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`, and `pnpm build`.
4. Run `pnpm test:live-preview` only after an operator sets `TELEGRAM_AGENT_LIVE_PREVIEW=authorized` for that exact Preview project and supplies the preview Sandbox name, Google OAuth credentials, and a pulled OIDC token. The command exits before any Sandbox or Drive call when that authorization is absent.
5. Deploy Production and check `/api/health` before any Telegram traffic.
6. Register the Telegram webhook last, at `https://<production-host>/api/telegram/webhook`, with the webhook secret and private message updates. Then run one private-chat smoke message and one dashboard/archive check.

The Sandbox exposes no public port. Next.js reaches it through the authenticated Vercel Sandbox SDK.

## Webhook removal

Remove or disable the Telegram webhook before a rollback or before a deployment that cannot commit state. Leave the Google Drive folder unchanged.
