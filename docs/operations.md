# Operations

`GET /api/health` reports safe readiness states and validates that `DATABASE_URL` is a PostgreSQL URL. It never returns or logs the connection string.

Each worker session hydrates its empty scratch tree from PostgreSQL. Every committed logical file is then upserted into `telegram_agent_files`; deletions remove the matching row. PostgreSQL is the source of truth. Scratch files, locks, and exports are not durable.

Back up and monitor the PostgreSQL service using the provider's facilities. Restrict the database role and network access, rotate the connection string as a secret, and do not configure Google OAuth or Drive credentials.

## Troubleshooting worker failures

Filter Vercel logs by the `correlationId` from the failed webhook event. Worker
failures include a bounded `metadata` object that is safe to retain in logs:

- `stage: bootstrap` points to database or process initialization.
- `stage: persistence-sync` points to loading durable state from PostgreSQL.
- `stage: operation` points to the Telegram turn, model request, or delivery.
- `stage: worker-log` points to writing the worker's durable completion log.
- `kind` is the JavaScript exception class, such as `TypeError` or `Error`.
- `causeCode` is an allowlisted runtime or provider code, such as a Node network
  code or PostgreSQL SQLSTATE.
- `status` is an HTTP-like status exposed by the failing dependency.

The exception message, stack, request body, connection string, and credentials
are intentionally not transported out of the Sandbox. Use the stage and
structured code to select the next system to inspect. For example,
`persistence-sync` plus PostgreSQL SQLSTATE `28P01` indicates database
authentication, while `operation` plus status `401` points to a model or
Telegram credential. If the code remains `INTERNAL_ERROR`, report the complete
`metadata` object and correlation ID; unlike the raw exception, those fields are
designed to be shared safely.

`persistence-sync` plus `causeCode: ENETUNREACH` is reported as
`DATABASE_NETWORK_UNREACHABLE`. It means the Sandbox has no route to the address
returned by the database hostname. This commonly occurs when `DATABASE_URL`
uses an IPv6-only direct database endpoint. Replace it with the provider's
IPv4-compatible pooled or session-pooler connection string in
`SANDBOX_DATABASE_URL`, redeploy, and send a new Telegram message. The existing
`DATABASE_URL` can remain the direct URL for controller-side access. Do not
remove provider-required SSL query parameters.
