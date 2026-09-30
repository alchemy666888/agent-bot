# Deployment

The application runs on Vercel with a private Sandbox worker. PostgreSQL is the only durable persistence system; the worker's `/tmp/telegram-agent` tree is a scratch projection hydrated from the database at the start of a session.

Set all variables documented in `.env.example`, including a secret `DATABASE_URL` in either `postgresql://user:password@host:5432/database` or `postgres://...` form. The application creates the `telegram_agent_files` table on first use. The database role therefore needs `CREATE` on the target schema and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on that table.

Deploy with `pnpm build`, check `GET /api/health`, and register the Telegram webhook last. Health validates the connection-string format without opening a connection or exposing credentials.
