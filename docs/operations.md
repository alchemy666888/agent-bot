# Operations

`GET /api/health` reports safe readiness states and validates that `DATABASE_URL` is a PostgreSQL URL. It never returns or logs the connection string.

Each worker session hydrates its empty scratch tree from PostgreSQL. Every committed logical file is then upserted into `telegram_agent_files`; deletions remove the matching row. PostgreSQL is the source of truth. Scratch files, locks, and exports are not durable.

Back up and monitor the PostgreSQL service using the provider's facilities. Restrict the database role and network access, rotate the connection string as a secret, and do not configure Google OAuth or Drive credentials.
