import {
  isTelegramActorAllowed,
  type TelegramAllowlist,
} from "../../shared/telegram-allowlist";
import type { TelegramInput } from "./input";

export const TELEGRAM_ACCESS_DENIED_TEXT =
  "我只會為鴨鴨和他的女朋友們工作。\n\n如果你想我為你工作，你需要成為鴨鴨的女朋友。";

/** Ignored updates have no sender. Every other update must match ALLOW_USERS. */
export function telegramUpdateAllowed(
  allowlist: TelegramAllowlist,
  input: TelegramInput,
): boolean {
  if (input.kind === "ignored") return true;
  if (input.kind === "text" || input.kind === "callback")
    return isTelegramActorAllowed(allowlist, input.userId, input.username);
  if (!input.userId) return false;
  return isTelegramActorAllowed(allowlist, input.userId, input.username);
}
