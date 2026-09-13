CREATE TABLE IF NOT EXISTS "telegram_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "telegram_user_id" bigint NOT NULL,
  "username" text,
  "language_code" text,
  "first_seen_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "telegram_users_telegram_user_id_uq" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "telegram_users"("id") ON DELETE RESTRICT,
  "status" text NOT NULL CONSTRAINT "conversations_status_ck" CHECK ("status" IN ('active', 'archived')),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "archived_at" timestamptz,
  CONSTRAINT "conversations_archived_at_ck" CHECK (("status" = 'active' AND "archived_at" IS NULL) OR ("status" = 'archived' AND "archived_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_updates" (
  "update_id" bigint PRIMARY KEY NOT NULL,
  "telegram_user_id" bigint,
  "chat_id" bigint,
  "message_id" bigint,
  "kind" text NOT NULL CONSTRAINT "telegram_updates_kind_ck" CHECK ("kind" IN ('text', 'command', 'unsupported')),
  "state" text DEFAULT 'received' NOT NULL CONSTRAINT "telegram_updates_state_ck" CHECK ("state" IN ('received', 'locked', 'prompt_saved', 'model_complete', 'delivery_complete', 'failed')),
  "attempt_count" integer DEFAULT 0 NOT NULL CONSTRAINT "telegram_updates_attempt_count_ck" CHECK ("attempt_count" >= 0),
  "last_error_stage" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE RESTRICT,
  "telegram_update_id" bigint REFERENCES "telegram_updates"("update_id") ON DELETE RESTRICT,
  "role" text NOT NULL CONSTRAINT "messages_role_ck" CHECK ("role" IN ('user', 'assistant')),
  "source" text NOT NULL CONSTRAINT "messages_source_ck" CHECK ("source" IN ('user_text', 'command', 'model', 'system_response')),
  "content" text NOT NULL,
  "telegram_message_id" bigint,
  "telegram_message_ids" bigint[],
  "status" text NOT NULL CONSTRAINT "messages_status_ck" CHECK ("status" IN ('received', 'processing', 'generated', 'sent', 'failed')),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE RESTRICT,
  "response_message_id" uuid REFERENCES "messages"("id") ON DELETE RESTRICT,
  "provider" text NOT NULL CONSTRAINT "model_runs_provider_ck" CHECK ("provider" = 'deepseek'),
  "model" text NOT NULL CONSTRAINT "model_runs_model_ck" CHECK ("model" = 'deepseek-v4-pro'),
  "thinking_enabled" boolean NOT NULL,
  "requested_reasoning_effort" text NOT NULL CONSTRAINT "model_runs_reasoning_effort_ck" CHECK ("requested_reasoning_effort" IN ('low', 'medium', 'high', 'max')),
  "provider_request_id" text,
  "input_tokens" bigint CONSTRAINT "model_runs_input_tokens_ck" CHECK ("input_tokens" IS NULL OR "input_tokens" >= 0),
  "output_tokens" bigint CONSTRAINT "model_runs_output_tokens_ck" CHECK ("output_tokens" IS NULL OR "output_tokens" >= 0),
  "input_price_per_million" numeric(30,12),
  "output_price_per_million" numeric(30,12),
  "estimated_input_cost" numeric(30,12),
  "estimated_output_cost" numeric(30,12),
  "estimated_total_cost" numeric(30,12),
  "latency_ms" integer CONSTRAINT "model_runs_latency_ck" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
  "status" text NOT NULL CONSTRAINT "model_runs_status_ck" CHECK ("status" IN ('started', 'succeeded', 'failed')),
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_errors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "telegram_update_id" bigint REFERENCES "telegram_updates"("update_id") ON DELETE RESTRICT,
  "model_run_id" uuid REFERENCES "model_runs"("id") ON DELETE RESTRICT,
  "correlation_id" text NOT NULL,
  "stage" text NOT NULL CONSTRAINT "application_errors_stage_length_ck" CHECK (char_length("stage") <= 64),
  "error_class" text NOT NULL CONSTRAINT "application_errors_class_length_ck" CHECK (char_length("error_class") <= 64),
  "error_code" text NOT NULL CONSTRAINT "application_errors_code_length_ck" CHECK (char_length("error_code") <= 64),
  "safe_message" text NOT NULL CONSTRAINT "application_errors_message_length_ck" CHECK (char_length("safe_message") <= 500),
  "retryable" boolean NOT NULL,
  "retry_number" integer NOT NULL CONSTRAINT "application_errors_retry_number_ck" CHECK ("retry_number" >= 0),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_one_active_per_user_uq" ON "conversations" ("user_id") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "conversations_user_created_idx" ON "conversations" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "telegram_updates_user_created_idx" ON "telegram_updates" ("telegram_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "telegram_updates_state_updated_idx" ON "telegram_updates" ("state", "updated_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "messages_update_role_uq" ON "messages" ("telegram_update_id", "role") WHERE "telegram_update_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx" ON "messages" ("conversation_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "messages_status_created_idx" ON "messages" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "messages_search_idx" ON "messages" USING gin (to_tsvector('simple', "content"));
CREATE INDEX IF NOT EXISTS "model_runs_status_started_idx" ON "model_runs" ("status", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "model_runs_request_message_idx" ON "model_runs" ("request_message_id");
CREATE INDEX IF NOT EXISTS "application_errors_created_idx" ON "application_errors" ("created_at" DESC, "id");
CREATE INDEX IF NOT EXISTS "application_errors_stage_created_idx" ON "application_errors" ("stage", "created_at" DESC);
