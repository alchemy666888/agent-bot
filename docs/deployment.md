# Deployment

The application runs on Vercel with a private Sandbox worker. PostgreSQL is the only durable persistence system; the worker's `/tmp/telegram-agent` tree is a scratch projection hydrated from the database at the start of a session.

Set all variables documented in `.env.example`, including a secret `DATABASE_URL` in either `postgresql://user:password@host:5432/database` or `postgres://...` form. The application creates the `telegram_agent_files` table on first use. The database role therefore needs `CREATE` on the target schema and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on that table.

The Sandbox running the worker must be able to reach the database hostname over
IPv4. If the database provider offers both a direct endpoint and a pooled or
session-pooler endpoint, use the provider's IPv4-compatible pooled endpoint for
`DATABASE_URL`. An IPv6-only direct endpoint fails from an IPv4-only Sandbox
network with `ENETUNREACH`; changing application credentials, SSL options, or
Vercel function regions does not make that endpoint reachable. Preserve any SSL
query parameters supplied by the database provider when copying the pooled URL.
The application normalizes the legacy `sslmode=require`, `prefer`, and
`verify-ca` aliases to `sslmode=verify-full`, retaining node-postgres's strict
certificate and hostname verification while avoiding its migration warning.
URLs that explicitly set `uselibpqcompat=true` are left unchanged.

For Aiven, copy the complete CA certificate (including the `BEGIN CERTIFICATE`
and `END CERTIFICATE` lines) into the multiline `AIVEN_PG_CA` Vercel environment
variable. When it is set, the application passes that CA directly to
node-postgres with certificate verification enabled and removes URL-based SSL
options before creating the pool so they cannot override the trusted CA.

Deploy with `pnpm build`, check `GET /api/health`, and register the Telegram webhook last. Health validates the connection-string format without opening a connection or exposing credentials.
