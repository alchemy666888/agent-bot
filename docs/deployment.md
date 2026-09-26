# Deployment

This application runs on Vercel Hobby. Durable data is ordinary files on one named Sandbox Drive mounted into one named private Sandbox. Both resources stay in `sin1`. PostgreSQL, SQLite, object storage, and any second durable store are out of scope.

## Project setup

1. Create or link the Vercel project.
2. Select the Singapore Sandbox region. The controller always sends `region: "sin1"` and rejects any other returned region or mount.
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
- `SANDBOX_DRIVE_NAME`
- `SANDBOX_NAME`

Optional variables use the defaults in `src/server/config/index.ts`. If `SANDBOX_REGION` is set, it must be `sin1`.

`TELEGRAM_AGENT_LOCAL_ROOT` is a test-only filesystem switch for mocked worker commands. The server ignores it whenever `VERCEL` is set, so Preview and Production always use the named Drive.

## Preview and Production

Use different Drive and Sandbox names for Preview and Production. Live checks may use only names that match `telegram-agent-preview-*`. Never point a test at the production Drive.

1. Deploy a Preview build.
2. Confirm health returns `ready` or a sanitized `degraded` state and does not create a Drive by itself.
3. Run the local suites: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`, and `pnpm build`.
4. Run `pnpm test:live-preview` only after an operator sets `TELEGRAM_AGENT_LIVE_PREVIEW=authorized` for that exact Preview project and supplies the named test resources plus a pulled OIDC token. The command exits before any Sandbox call when that authorization is absent.
5. Deploy Production and check `/api/health` before any Telegram traffic.
6. Register the Telegram webhook last, at `https://<production-host>/api/telegram/webhook`, with the webhook secret and private message updates. Then run one private-chat smoke message and one dashboard/archive check.

The Sandbox exposes no public port. Next.js reaches it through the authenticated Vercel Sandbox SDK.

## Webhook removal

Remove or disable the Telegram webhook before a rollback or before a deployment that cannot commit state. Leave the Drive attached and unchanged.
