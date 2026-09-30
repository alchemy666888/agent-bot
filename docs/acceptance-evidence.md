# Acceptance evidence

The persistence migration is verified locally by the automated suite and production build. PostgreSQL is now the sole durable store, represented by the `telegram_agent_files` table. A live database verification requires the operator-provided `DATABASE_URL` and is intentionally not run with placeholder credentials.

See `README.md` for the complete local verification commands and `docs/deployment.md` for database permissions and deployment steps.
