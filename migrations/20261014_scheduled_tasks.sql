-- User-requested Telegram schedules. Applied only by the privileged migration
-- job; application startup never creates or alters these objects.

CREATE TABLE scheduled_tasks (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^[a-f0-9]{8}$'),
  owner_telegram_user_id text NOT NULL CHECK (owner_telegram_user_id ~ '^[1-9][0-9]*$'),
  chat_id text NOT NULL CHECK (chat_id ~ '^[1-9][0-9]*$'),
  username text CHECK (username IS NULL OR username ~ '^[A-Za-z0-9_]{5,32}$'),
  language_code text CHECK (
    language_code IS NULL OR length(language_code) BETWEEN 1 AND 16
  ),
  source_message text NOT NULL CHECK (length(source_message) BETWEEN 1 AND 4000),
  user_prompt text NOT NULL CHECK (length(user_prompt) BETWEEN 1 AND 2000),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (
    failure_count >= 0 AND failure_count <= 100
  ),
  lease_owner text CHECK (
    lease_owner IS NULL OR lease_owner ~ '^[0-9a-f-]{36}$'
  ),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX scheduled_tasks_due
  ON scheduled_tasks (next_run_at, id)
  WHERE status = 'active';

CREATE INDEX scheduled_tasks_owner
  ON scheduled_tasks (owner_telegram_user_id, created_at);
