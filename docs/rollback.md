# Rollback

Disable the Telegram webhook before a rollback that cannot commit state. Back up PostgreSQL first and do not drop or truncate `telegram_agent_files`.

Only roll back to a version that understands every persisted event schema version. After deployment, verify `/api/health`, query the dashboard, and re-enable the webhook. A replacement Sandbox can hydrate from the same PostgreSQL database because its local filesystem is disposable.
