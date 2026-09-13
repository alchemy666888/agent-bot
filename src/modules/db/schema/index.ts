import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
}

export const telegramUsers = pgTable(
  'telegram_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    username: text('username'),
    languageCode: text('language_code'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('telegram_users_telegram_user_id_uq').on(table.telegramUserId),
  ],
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => telegramUsers.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'conversations_status_ck',
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      'conversations_archived_at_ck',
      sql`(${table.status} = 'active' and ${table.archivedAt} is null) or (${table.status} = 'archived' and ${table.archivedAt} is not null)`,
    ),
    uniqueIndex('conversations_one_active_per_user_uq')
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    index('conversations_user_created_idx').on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
)

export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    updateId: bigint('update_id', { mode: 'bigint' }).primaryKey(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }),
    chatId: bigint('chat_id', { mode: 'bigint' }),
    messageId: bigint('message_id', { mode: 'bigint' }),
    kind: text('kind').notNull(),
    state: text('state').default('received').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastErrorStage: text('last_error_stage'),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'telegram_updates_kind_ck',
      sql`${table.kind} in ('text', 'command', 'unsupported')`,
    ),
    check(
      'telegram_updates_state_ck',
      sql`${table.state} in ('received', 'locked', 'prompt_saved', 'model_complete', 'delivery_complete', 'failed')`,
    ),
    check('telegram_updates_attempt_count_ck', sql`${table.attemptCount} >= 0`),
    index('telegram_updates_user_created_idx').on(
      table.telegramUserId,
      table.createdAt.desc(),
    ),
    index('telegram_updates_state_updated_idx').on(
      table.state,
      table.updatedAt.desc(),
    ),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    telegramUpdateId: bigint('telegram_update_id', {
      mode: 'bigint',
    }).references(() => telegramUpdates.updateId, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    source: text('source').notNull(),
    content: text('content').notNull(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }),
    telegramMessageIds: bigint('telegram_message_ids', {
      mode: 'bigint',
    }).array(),
    status: text('status').notNull(),
    ...timestamps,
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    check('messages_role_ck', sql`${table.role} in ('user', 'assistant')`),
    check(
      'messages_source_ck',
      sql`${table.source} in ('user_text', 'command', 'model', 'system_response')`,
    ),
    check(
      'messages_status_ck',
      sql`${table.status} in ('received', 'processing', 'generated', 'sent', 'failed')`,
    ),
    uniqueIndex('messages_update_role_uq')
      .on(table.telegramUpdateId, table.role)
      .where(sql`${table.telegramUpdateId} is not null`),
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    index('messages_status_created_idx').on(
      table.status,
      table.createdAt.desc(),
    ),
    index('messages_search_idx').using(
      'gin',
      sql`to_tsvector('simple', ${table.content})`,
    ),
  ],
)

export const modelRuns = pgTable(
  'model_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestMessageId: uuid('request_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    responseMessageId: uuid('response_message_id').references(
      () => messages.id,
      {
        onDelete: 'restrict',
      },
    ),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    thinkingEnabled: boolean('thinking_enabled').notNull(),
    requestedReasoningEffort: text('requested_reasoning_effort').notNull(),
    providerRequestId: text('provider_request_id'),
    inputTokens: bigint('input_tokens', { mode: 'bigint' }),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }),
    inputPricePerMillion: numeric('input_price_per_million', {
      precision: 30,
      scale: 12,
    }),
    outputPricePerMillion: numeric('output_price_per_million', {
      precision: 30,
      scale: 12,
    }),
    estimatedInputCost: numeric('estimated_input_cost', {
      precision: 30,
      scale: 12,
    }),
    estimatedOutputCost: numeric('estimated_output_cost', {
      precision: 30,
      scale: 12,
    }),
    estimatedTotalCost: numeric('estimated_total_cost', {
      precision: 30,
      scale: 12,
    }),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check('model_runs_provider_ck', sql`${table.provider} = 'deepseek'`),
    check('model_runs_model_ck', sql`${table.model} = 'deepseek-v4-pro'`),
    check(
      'model_runs_reasoning_effort_ck',
      sql`${table.requestedReasoningEffort} in ('low', 'medium', 'high', 'max')`,
    ),
    check(
      'model_runs_status_ck',
      sql`${table.status} in ('started', 'succeeded', 'failed')`,
    ),
    check(
      'model_runs_input_tokens_ck',
      sql`${table.inputTokens} is null or ${table.inputTokens} >= 0`,
    ),
    check(
      'model_runs_output_tokens_ck',
      sql`${table.outputTokens} is null or ${table.outputTokens} >= 0`,
    ),
    check(
      'model_runs_latency_ck',
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    index('model_runs_status_started_idx').on(
      table.status,
      table.startedAt.desc(),
    ),
    index('model_runs_request_message_idx').on(table.requestMessageId),
  ],
)

export const applicationErrors = pgTable(
  'application_errors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramUpdateId: bigint('telegram_update_id', {
      mode: 'bigint',
    }).references(() => telegramUpdates.updateId, { onDelete: 'restrict' }),
    modelRunId: uuid('model_run_id').references(() => modelRuns.id, {
      onDelete: 'restrict',
    }),
    correlationId: text('correlation_id').notNull(),
    stage: text('stage').notNull(),
    errorClass: text('error_class').notNull(),
    errorCode: text('error_code').notNull(),
    safeMessage: text('safe_message').notNull(),
    retryable: boolean('retryable').notNull(),
    retryNumber: integer('retry_number').notNull(),
    ...timestamps,
  },
  (table) => [
    check('application_errors_retry_number_ck', sql`${table.retryNumber} >= 0`),
    check(
      'application_errors_stage_length_ck',
      sql`char_length(${table.stage}) <= 64`,
    ),
    check(
      'application_errors_class_length_ck',
      sql`char_length(${table.errorClass}) <= 64`,
    ),
    check(
      'application_errors_code_length_ck',
      sql`char_length(${table.errorCode}) <= 64`,
    ),
    check(
      'application_errors_message_length_ck',
      sql`char_length(${table.safeMessage}) <= 500`,
    ),
    index('application_errors_created_idx').on(
      table.createdAt.desc(),
      table.id,
    ),
    index('application_errors_stage_created_idx').on(
      table.stage,
      table.createdAt.desc(),
    ),
  ],
)
