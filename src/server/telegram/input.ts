import { z } from "zod";
import { telegramChatId, telegramId } from "../../shared/ids";

const chatIdPattern = /^-?[1-9]\d*$/;
const GROUP_CHAT = new Set(["group", "supergroup"]);

const updateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: z
      .object({
        message_id: z.number().int(),
        chat: z.object({
          id: z.union([z.number(), z.string()]),
          type: z.string(),
        }),
        from: z
          .object({
            id: z.union([z.number(), z.string()]),
            username: z.string().optional(),
            language_code: z.string().optional(),
          })
          .optional(),
        text: z.string().optional(),
      })
      .optional(),
    edited_message: z.unknown().optional(),
    callback_query: z
      .object({
        id: z.union([z.string(), z.number()]),
        from: z.object({
          id: z.union([z.number(), z.string()]),
          username: z.string().optional(),
          language_code: z.string().optional(),
        }),
        message: z
          .object({
            message_id: z.number().int(),
            chat: z.object({
              id: z.union([z.number(), z.string()]),
              type: z.string(),
            }),
          })
          .optional(),
        data: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
export type TelegramInput =
  | {
      kind: "text";
      updateId: string;
      messageId: string;
      chatId: string;
      userId: string;
      username?: string;
      languageCode?: string;
      text: string;
      /** Set for group and supergroup chats. Omitted for private chats. */
      chatScope?: "group";
      replyToMessageId?: string;
    }
  | {
      kind: "callback";
      updateId: string;
      callbackQueryId: string;
      messageId: string;
      chatId: string;
      userId: string;
      username?: string;
      languageCode?: string;
      data: string;
    }
  | {
      kind: "unsupported";
      updateId: string;
      chatId: string;
      replyToMessageId?: string;
      userId?: string;
      username?: string;
    }
  | { kind: "ignored"; updateId: string };

export const telegramInputSchema: z.ZodType<TelegramInput> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("callback"),
        updateId: z.string().regex(/^\d+$/),
        callbackQueryId: z.string().min(1).max(128),
        messageId: z.string().regex(/^\d+$/),
        chatId: z.string().regex(/^[1-9]\d*$/),
        userId: z.string().regex(/^[1-9]\d*$/),
        username: z.string().optional(),
        languageCode: z.string().optional(),
        // Callback data is an opaque capability, never a command or identifier.
        data: z
          .string()
          .min(16)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal("text"),
        updateId: z.string().regex(/^\d+$/),
        messageId: z.string().regex(/^\d+$/),
        chatId: z.string().regex(chatIdPattern),
        userId: z.string().regex(/^[1-9]\d*$/),
        username: z.string().optional(),
        languageCode: z.string().optional(),
        text: z.string().min(1),
        chatScope: z.literal("group").optional(),
        replyToMessageId: z.string().regex(/^\d+$/).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("unsupported"),
        updateId: z.string().regex(/^\d+$/),
        chatId: z.string().regex(chatIdPattern),
        replyToMessageId: z.string().regex(/^\d+$/).optional(),
        userId: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        username: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("ignored"),
        updateId: z.string().regex(/^\d+$/),
      })
      .strict(),
  ]);
export function extractTelegramInput(raw: unknown): TelegramInput {
  const update = updateSchema.parse(raw);
  const updateId = String(update.update_id);
  const callback = update.callback_query;
  if (callback) {
    if (
      !callback.message ||
      callback.message.chat.type !== "private" ||
      callback.data === undefined
    )
      return { kind: "ignored", updateId };
    const candidate = {
      kind: "callback" as const,
      updateId,
      callbackQueryId: String(callback.id),
      messageId: String(callback.message.message_id),
      chatId: telegramId(callback.message.chat.id),
      userId: telegramId(callback.from.id),
      username: callback.from.username,
      languageCode: callback.from.language_code,
      data: callback.data,
    };
    // Invalid/oversized callback capabilities are ignored rather than reflected.
    return telegramInputSchema.safeParse(candidate).success
      ? candidate
      : { kind: "ignored", updateId };
  }
  if (update.edited_message || !update.message)
    return { kind: "ignored", updateId };
  const chatType = update.message.chat.type;
  if (chatType !== "private" && !GROUP_CHAT.has(chatType))
    return { kind: "ignored", updateId };
  const chatId = telegramChatId(update.message.chat.id);
  const replyToMessageId = String(update.message.message_id);
  if (!update.message.text || !update.message.from) {
    const from = update.message.from;
    return {
      kind: "unsupported",
      updateId,
      chatId,
      ...(chatType === "private" ? {} : { replyToMessageId }),
      ...(from
        ? {
            userId: telegramId(from.id),
            username: from.username,
          }
        : {}),
    };
  }
  return {
    kind: "text",
    updateId,
    messageId: replyToMessageId,
    chatId,
    userId: telegramId(update.message.from.id),
    username: update.message.from.username,
    languageCode: update.message.from.language_code,
    text: update.message.text,
    ...(chatType === "private"
      ? {}
      : { chatScope: "group" as const, replyToMessageId }),
  };
}

/** Private turns stay on the sender. A group shares one transcript. */
export function conversationScopeKey(input: {
  userId: string;
  chatId: string;
  chatScope?: "group";
}): string {
  return input.chatScope === "group" ? `group${input.chatId}` : input.userId;
}
