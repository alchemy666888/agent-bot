# Telegram Agent

Telegram Agent is a public conversational assistant for private Telegram chats. People message the bot in text. The app answers with DeepSeek model `deepseek-v4-pro`, stores durable state in PostgreSQL, and gives the operator a secret-protected read-only dashboard plus a consistent export.

Telegram is the user interface. Next.js on Vercel receives webhooks, serves the dashboard, and controls a private Sandbox in Singapore (`sin1`). The Sandbox is the only process that reads and writes application data. All durable application data and structured logs are stored in PostgreSQL. The Sandbox filesystem is only a scratch working copy.

Supported input includes private text, `/start`, `/help`, `/new`, and the installed-skill commands specified in `specs/telegram-agent/requirements.md`. A skill is drafted through categorized clarification, reviewed, iteratively revised, and installed only after revision-bound explicit approval. User-created skills are private to their Telegram owner; operator-managed global skills are visible to everyone. There is no user sharing or public marketplace. Discovery never implies selection: `/skill use <stable-id>` or an equivalent signed button is required before execution.

PostgreSQL is the sole source of truth for conversations and installed skills. The Sandbox is disposable execution infrastructure. Approved skill versions may use only capabilities present in the operator registry and explicitly granted at installation; prompt text and model output cannot grant tools. The bounded tool loop authorizes and audits every call, and non-retry-safe unknown outcomes are not automatically replayed.

Live Preview verification and the final acceptance audit are deferred for this stage. A real `sin1` stop/resume check has not been recorded.

## Project structure

```text
src/app/                  Next.js routes: home, login, dashboard, webhook, health, download
src/components/dashboard/ Read-only dashboard markup
src/server/config/        Environment validation and defaults
src/server/auth/          Dashboard session and download guards
src/server/sandbox/       Private Sandbox controller
src/server/telegram/      Webhook input minimization and worker dispatch
src/server/dashboard/     Query view models
src/server/export/        Authenticated ZIP stream
src/shared/               Contracts, identifiers, and redaction
src/worker/               Sandbox worker: turns, DeepSeek, files, locks, queries, export
tests/                    Unit, integration, contract, browser, and gated live checks
docs/                     Deployment, operations, rollback, and acceptance notes
specs/telegram-agent/     Approved requirements, design, tasks, and implementation prompt
scripts/verify-preview.mjs
```

Public routes:

| Path                    | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `/login`                | Submit `DASHBOARD_SECRET` and receive a 24-hour session cookie               |
| `/logout`               | Same-origin POST that clears the session                                     |
| `/dashboard`            | Read-only overview and linked record pages                                   |
| `/api/telegram/webhook` | Telegram `POST` webhook                                                      |
| `/api/health`           | `ready` or `degraded` configuration check; it does not connect to PostgreSQL |
| `/api/download`         | Authenticated ZIP of persisted `data/`                                       |

Durable records live in PostgreSQL. Existing conversation data may retain a logical file compatibility representation in `telegram_agent_files`, but installed skills use normalized, migrated relational tables for drafts, immutable revisions/versions, grants, selections, executions, tool calls, idempotency, and audit events. Any JSONL tree or Sandbox copy is generated scratch/export data rather than a second source of truth.

Installed-skills implementation and acceptance are planned in `specs/telegram-agent/tasks.md`; the feature must remain behind `SKILLS_ENABLED=false` until the migrations, modules, named acceptance tests, cross-user authorization check, and isolated restore rehearsal are complete.

## Vercel Cloud, Hobby plan

Deploy this repository as one Next.js project on the Vercel Hobby plan. The build command is `pnpm build`, which bundles `dist/worker.mjs` and then builds the App Router app. Node.js 22 or newer is required. Production authentication to the Sandbox uses Vercel managed OIDC. Do not store a long-lived Vercel access token for that path.

Runtime constraints that this app accepts:

- One named Sandbox runs the worker while PostgreSQL remains independently durable.
- The controller always requests region `sin1` and a single `/workspace` mount. It opens no public Sandbox port.
- The Sandbox timeout sent by the controller is 45 minutes, which is the Hobby ceiling used in code.
- Availability is best-effort. The app adds no rate limit, storage cap, or login lockout of its own. Hobby, PostgreSQL-provider, Telegram, and DeepSeek limits still apply.
- Use separate PostgreSQL databases and Sandbox names for Preview and Production. Do not point tests at the production database.

After the first deployment, set `APP_URL` to the assigned `https://…vercel.app` origin and deploy again. Check `GET /api/health` before registering Telegram. Register the webhook last:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d "{\"url\":\"${APP_URL}/api/telegram/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"]}"
```

To take the bot offline, call Telegram `deleteWebhook` first. Leave the PostgreSQL database in place. Rollback steps are in `docs/rollback.md`.

## Environment variables

Copy `.env.example` to `.env.local` for local work. `.env.local` is gitignored. On Vercel, set the same names in Project Settings → Environment Variables. Do not commit values.

Validation lives in `src/server/config/index.ts`. Missing or invalid required values fail closed at the entry point that needs them. `/api/health` reports that as `degraded` and does not print the values.

### Required

These have no default. An empty value is invalid.

| Variable                            | Definition                                                                                                                                                                | How to get the value                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                | HTTP API token for the bot that receives private chats                                                                                                                    | Open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token from the reply                                                                                                   |
| `TELEGRAM_WEBHOOK_SECRET`           | Shared secret Telegram sends in `X-Telegram-Bot-Api-Secret-Token`. The app accepts any non-empty string. Telegram itself accepts only 1–256 characters from `A-Za-z0-9_-` | Choose it yourself, for example `openssl rand -hex 32`. Use the same value in `setWebhook` `secret_token`                                                                                      |
| `DEEPSEEK_API_KEY`                  | Bearer key for `https://api.deepseek.com`                                                                                                                                 | Create a key at [DeepSeek API keys](https://platform.deepseek.com/api_keys)                                                                                                                    |
| `DASHBOARD_SECRET`                  | Login password and the only accepted download bearer token. Any non-empty string is valid, including Unicode                                                              | Choose it yourself. Anyone who has it can read the dashboard and download the archive                                                                                                          |
| `SESSION_SIGNING_SECRET`            | Key that signs the `__Host-telegram-agent-session` cookie. It is separate from `DASHBOARD_SECRET`                                                                         | Choose a different value yourself, for example `openssl rand -base64 32`                                                                                                                       |
| `APP_URL`                           | Public site origin used for same-origin login and logout. It must be an absolute URL                                                                                      | After the first Vercel deploy, set this to the production origin, such as `https://your-project.vercel.app`, with no path and no trailing slash required by the parser beyond a valid URL      |
| `DEEPSEEK_INPUT_PRICE_PER_MILLION`  | Nonnegative decimal price for one million input tokens, stored as a snapshot on each model run                                                                            | Read the current `deepseek-v4-pro` input price at [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing). The app stores one number and does not switch peak and off-peak rates |
| `DEEPSEEK_OUTPUT_PRICE_PER_MILLION` | Nonnegative decimal price for one million output tokens                                                                                                                   | Read the current `deepseek-v4-pro` output price on that same page                                                                                                                              |
| `DATABASE_URL`                      | PostgreSQL connection string used for all durable persistence                                                                                                             | Supply a `postgresql://` or `postgres://` connection string; keep it secret                                                                                                                    |
| `DATABASE_MIGRATOR_URL`             | Privileged PostgreSQL URL used only by the explicit migration command; never expose it to the application runtime                                                         | Supply through CI/deployment secret injection and remove it from the runtime environment                                                                                                       |
| `SANDBOX_NAME`                      | Stable name of the one private Sandbox that runs the worker                                                                                                               | Choose a new name, such as `telegram-agent`. The Sandbox filesystem is scratch; PostgreSQL is the durable copy                                                                                 |

### Optional

| Variable                     | Default when unset                                                                                                                                          | Definition                                                                                        | How to get the value                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AIVEN_PG_CA`                | Unset; PostgreSQL uses the SSL options from `DATABASE_URL`                                                                                                  | Aiven PostgreSQL CA certificate                                                                   | Paste the complete PEM certificate as a multiline Vercel environment variable                                                                                            |
| `SKILLS_ENABLED`             | `false`                                                                                                                                                     | Emergency release gate for installed-skill execution; migration and smoke tests occur while false | Set to `true` only after acceptance and restore evidence is approved                                                                                                     |
| `SKILL_MAX_TOOL_STEPS`       | `5`                                                                                                                                                         | Maximum capability proposals in one skill execution                                               | Keep within the operator-approved bound                                                                                                                                  |
| `SKILL_EXECUTION_TIMEOUT_MS` | `60000`                                                                                                                                                     | Overall skill execution deadline in milliseconds                                                  | Tune only after timeout/recovery acceptance tests                                                                                                                        |
| `CAPABILITY_POLICY_PATH`     | Unset                                                                                                                                                       | Optional deployed, operator-controlled capability policy                                          | Point to a server-side policy artifact; user prompts cannot modify it                                                                                                    |
| `ASSISTANT_SYSTEM_PROMPT`    | `You are a helpful, accurate, and safe general-purpose assistant. Reply in the language of the user's latest message unless they request another language.` | System prompt sent with every model request                                                       | Leave it unset to use the default, or set the full prompt text                                                                                                           |
| `DEEPSEEK_THINKING_ENABLED`  | `true`                                                                                                                                                      | Turns DeepSeek thinking on or off. The only accepted values are `true` and `false`                | Leave it unset, or set `true` or `false`                                                                                                                                 |
| `DEEPSEEK_REASONING_EFFORT`  | `medium`                                                                                                                                                    | Reasoning effort sent to DeepSeek. The only accepted value is `medium`                            | Leave it unset. Setting anything else fails validation                                                                                                                   |
| `DEEPSEEK_BASE_URL`          | `https://api.deepseek.com`                                                                                                                                  | DeepSeek API origin. It must be a valid URL                                                       | Leave it unset unless DeepSeek gives you a different API origin                                                                                                          |
| `SANDBOX_REGION`             | `sin1`                                                                                                                                                      | Documented region check. The controller always sends `sin1` even when this is unset               | Leave it unset. If you set it, the only accepted value is `sin1`                                                                                                         |
| `VERCEL_OIDC_TOKEN`          | Unset. Production on Vercel uses managed OIDC and does not need this variable                                                                               | Short-lived credential for local Sandbox SDK calls                                                | From the project directory, run `vercel env pull`. That writes the token into `.env.local`. Do not copy it into the repository or into the Vercel production environment |

### Not production settings

| Variable                    | Use                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `TELEGRAM_AGENT_LOCAL_ROOT` | Tests only. Points worker commands at a local directory. The server ignores it when `VERCEL` is set |

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:integration
pnpm test:contracts
pnpm test:e2e
pnpm build
```

`pnpm dev` starts Next.js locally. Sandbox calls from a machine that is not Vercel need `VERCEL_OIDC_TOKEN` from `vercel env pull`, plus the required variables above.

Further operator steps are in `docs/deployment.md`, `docs/operations.md`, and `docs/rollback.md`.
