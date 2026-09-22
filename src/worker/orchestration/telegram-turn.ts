import type { ModelProvider } from "../../shared/contracts";
import { ConversationService } from "../conversations/service";
import { commandReply } from "../commands";
import { LockCoordinator } from "../locks/coordinator";
import { UpdateRepository } from "../updates/repository";
import type { TelegramClient } from "../telegram/client";
import type { TelegramInput } from "../../server/telegram/input";
export class TelegramTurn {
  constructor(
    private locks: LockCoordinator,
    private updates: UpdateRepository,
    private conversations: ConversationService,
    private model: ModelProvider,
    private telegram: Pick<TelegramClient, "typing" | "send">,
    private prompt: string,
  ) {}
  async handle(input: TelegramInput) {
    if (input.kind === "ignored") return;
    if (input.kind === "unsupported") {
      await this.telegram.send(input.chatId, "Please send a text message.");
      return;
    }
    await this.locks.withUser(input.userId, async () => {
      const existing = await this.updates.get(input.updateId);
      if (
        existing?.stage === "delivery_complete" ||
        existing?.stage === "failed"
      )
        return;
      const at = new Date().toISOString();
      if (!existing)
        await this.updates.save({
          updateId: input.updateId,
          stage: "received",
          updatedAt: at,
        });
      this.conversations.contact({
        id: input.userId,
        username: input.username,
        languageCode: input.languageCode,
        at,
      });
      const deterministic = commandReply(input.text);
      if (input.text === "/new")
        this.conversations.newConversation(input.userId);
      if (!existing || existing.stage === "received") {
        this.conversations.add(input.userId, "user", input.text, at);
        await this.updates.save({
          updateId: input.updateId,
          stage: "prompt_saved",
          updatedAt: at,
        });
      }
      await this.telegram.typing(input.chatId);
      let answer = existing?.assistantId
        ? this.conversations.message(existing.assistantId)?.text
        : undefined;
      if (!answer) {
        answer =
          deterministic ??
          (
            await this.model.generate(
              this.conversations.context(input.userId, this.prompt),
            )
          ).content;
        const assistant = this.conversations.add(
          input.userId,
          "assistant",
          answer,
        );
        await this.updates.save({
          updateId: input.updateId,
          stage: "model_complete",
          assistantId: assistant.id,
          updatedAt: new Date().toISOString(),
        });
      }
      await this.telegram.send(input.chatId, answer);
      await this.updates.save({
        updateId: input.updateId,
        stage: "delivery_complete",
        updatedAt: new Date().toISOString(),
      });
    });
  }
}
