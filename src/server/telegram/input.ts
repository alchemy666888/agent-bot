import { z } from "zod";
import { telegramId } from "../../shared/ids";

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
    }
  | { kind: "unsupported"; updateId: string; chatId: string }
  | { kind: "ignored"; updateId: string };

export const telegramInputSchema: z.ZodType<TelegramInput> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("text"),
        updateId: z.string().regex(/^\d+$/),
        messageId: z.string().regex(/^\d+$/),
        chatId: z.string().regex(/^[1-9]\d*$/),
        userId: z.string().regex(/^[1-9]\d*$/),
        username: z.string().optional(),
        languageCode: z.string().optional(),
        text: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("unsupported"),
        updateId: z.string().regex(/^\d+$/),
        chatId: z.string().regex(/^[1-9]\d*$/),
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
  if (
    update.edited_message ||
    !update.message ||
    update.message.chat.type !== "private"
  )
    return { kind: "ignored", updateId };
  const chatId = telegramId(update.message.chat.id);
  if (!update.message.text || !update.message.from)
    return { kind: "unsupported", updateId, chatId };
  return {
    kind: "text",
    updateId,
    messageId: String(update.message.message_id),
    chatId,
    userId: telegramId(update.message.from.id),
    username: update.message.from.username,
    languageCode: update.message.from.language_code,
    text: update.message.text,
  };
}
