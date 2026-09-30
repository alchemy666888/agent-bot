import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../../shared/contracts";
import { uuidV7 } from "../../shared/ids";
import { calculateCost } from "../model/usage";
import type {
  ConversationService,
  Message,
  UserProfile,
} from "../conversations/service";
import { handleCommand, type InstalledSkill } from "../commands";
import { LockCoordinator } from "../locks/coordinator";
import { UpdateRepository } from "../updates/repository";
import type { TelegramClient } from "../telegram/client";
import type { TelegramInput } from "../../server/telegram/input";
import { retryTransient } from "../model/retry";
import type { UpdateState } from "../updates/state-machine";
import type { SkillResolver } from "../skills/resolver";

const GENERIC_FAILURE =
  "Sorry, I couldn't complete that request. Please try again later.";

function isTransient(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    (error instanceof Error &&
      ["LOCK_TIMEOUT", "TELEGRAM_DELIVERY_FAILED"].includes(error.message))
  );
}

type MaybePromise<T> = T | Promise<T>;
type ConversationStore = {
  contact(
    ...args: Parameters<ConversationService["contact"]>
  ): MaybePromise<UserProfile>;
  newConversation(
    ...args: Parameters<ConversationService["newConversation"]>
  ): MaybePromise<unknown>;
  add(...args: Parameters<ConversationService["add"]>): MaybePromise<Message>;
  context(
    ...args: Parameters<ConversationService["context"]>
  ): MaybePromise<ModelRequest>;
  message(
    ...args: Parameters<ConversationService["message"]>
  ): MaybePromise<Message | undefined>;
  recordModelRun?(record: Record<string, unknown>): MaybePromise<void>;
};
export interface ModelAccounting {
  inputPricePerMillion?: string;
  outputPricePerMillion?: string;
  thinkingEnabled: boolean;
}
export class TelegramTurn {
  constructor(
    private locks: LockCoordinator,
    private updates: UpdateRepository,
    private conversations: ConversationStore,
    private model: ModelProvider,
    private telegram: Pick<TelegramClient, "typing" | "send">,
    private prompt: string,
    private observability?: {
      correlationId: string;
      recordFailure(input: {
        stage: string;
        error: unknown;
        updateId: string;
        userId: string;
      }): Promise<unknown>;
    },
    private accounting?: ModelAccounting,
    private skills?: SkillResolver,
  ) {}
  private checkpoint(userId: string, state: UpdateState) {
    return this.locks.withMutation(() => this.updates.save(state), userId);
  }
  async handle(input: TelegramInput) {
    if (input.kind === "ignored") return;
    if (input.kind === "unsupported") {
      await retryTransient(
        () => this.telegram.send(input.chatId, "Please send a text message."),
        isTransient,
      );
      return;
    }
    await this.locks.withUser(input.userId, async () => {
      const existing = await this.updates.get(input.updateId);
      if (existing?.telegramUserId && existing.telegramUserId !== input.userId)
        throw new Error("UPDATE_ACTOR_MISMATCH");
      if (
        existing?.stage === "delivery_complete" ||
        existing?.stage === "failed"
      )
        return;
      const at = new Date().toISOString();
      if (!existing)
        await this.checkpoint(input.userId, {
          updateId: input.updateId,
          telegramUserId: input.userId,
          stage: "received",
          updatedAt: at,
        });
      await this.conversations.contact({
        id: input.userId,
        username: input.username,
        languageCode: input.languageCode,
        at,
      });
      const command = handleCommand(input.text, this.skills, input.userId);
      const deterministic =
        command?.kind === "reply" ? command.text : undefined;
      if (input.text === "/new")
        await this.conversations.newConversation(input.userId);
      let requestMessageId: string | null = null;
      if (!existing || existing.stage === "received") {
        const userMessage = await this.conversations.add(
          input.userId,
          "user",
          input.text,
          at,
        );
        requestMessageId = userMessage.id;
        await this.checkpoint(input.userId, {
          updateId: input.updateId,
          telegramUserId: input.userId,
          stage: "prompt_saved",
          updatedAt: at,
        });
      }
      await this.telegram.typing(input.chatId).catch(() => undefined);
      const typingRefresh = setInterval(
        () => void this.telegram.typing(input.chatId).catch(() => undefined),
        4_000,
      );
      let answer = existing?.assistantId
        ? (await this.conversations.message(existing.assistantId))?.text
        : undefined;
      try {
        if (!answer) {
          let generated: ModelResponse | undefined;
          let latencyMs = 0;
          let resolution: ReturnType<SkillResolver["resolve"]> | undefined;
          try {
            if (deterministic) answer = deterministic;
            else {
              resolution = this.skills?.resolve(input.text);
              if (resolution?.kind === "ambiguous") {
                answer = `I found multiple relevant skills (${resolution.skillIds.join(", ")}). Please choose one with /skill <id>.`;
              } else if (
                resolution?.kind === "selected" &&
                resolution.skill.prohibitedActions.some((restriction) =>
                  input.text.toLowerCase().includes(restriction.toLowerCase()),
                )
              ) {
                answer =
                  "I can't perform that action because the selected skill prohibits it.";
              } else {
                const started = Date.now();
                const context = await this.conversations.context(
                  input.userId,
                  this.prompt,
                );
                generated = await retryTransient(
                  async () =>
                    this.model.generate({
                      ...context,
                      ...(resolution?.kind === "selected"
                        ? { skill: resolution.skill }
                        : {}),
                    }),
                  isTransient,
                );
                latencyMs = Date.now() - started;
                answer = generated.content;
              }
            }
          } catch (error) {
            await this.observability?.recordFailure({
              stage: "model",
              error,
              updateId: input.updateId,
              userId: input.userId,
            });
            await retryTransient(
              () => this.telegram.send(input.chatId, GENERIC_FAILURE),
              isTransient,
            );
            await this.checkpoint(input.userId, {
              updateId: input.updateId,
              telegramUserId: input.userId,
              stage: "failed",
              updatedAt: new Date().toISOString(),
            });
            return;
          }
          if (!answer) throw new Error("ASSISTANT_RESPONSE_MISSING");
          const assistant = await this.conversations.add(
            input.userId,
            "assistant",
            answer,
          );
          if (generated && this.accounting)
            await this.conversations.recordModelRun?.({
              id: uuidV7(),
              userId: input.userId,
              provider: "deepseek",
              model: "deepseek-v4-pro",
              thinkingEnabled: this.accounting.thinkingEnabled,
              effort: "medium",
              status: "completed",
              requestMessageId,
              responseMessageId: assistant.id,
              providerRequestId: generated.requestId ?? null,
              inputCount: generated.usage?.inputTokens ?? null,
              outputCount: generated.usage?.outputTokens ?? null,
              inputPricePerMillion:
                this.accounting.inputPricePerMillion ?? null,
              outputPricePerMillion:
                this.accounting.outputPricePerMillion ?? null,
              estimatedCost:
                generated.usage &&
                this.accounting.inputPricePerMillion &&
                this.accounting.outputPricePerMillion
                  ? calculateCost(
                      generated.usage.inputTokens,
                      generated.usage.outputTokens,
                      this.accounting.inputPricePerMillion,
                      this.accounting.outputPricePerMillion,
                    ).estimatedCost
                  : null,
              latencyMs,
              skillId:
                resolution?.kind === "selected" ? resolution.skill.id : null,
              skillVersion:
                resolution?.kind === "selected"
                  ? resolution.skill.version
                  : null,
              permittedCapabilities:
                resolution?.kind === "selected"
                  ? resolution.skill.capabilities.map((item) => item.id)
                  : [],
              capabilityAudit: generated.capabilityAudit ?? [],
              createdAt: new Date().toISOString(),
            });
          await this.checkpoint(input.userId, {
            updateId: input.updateId,
            telegramUserId: input.userId,
            stage: "model_complete",
            assistantId: assistant.id,
            updatedAt: new Date().toISOString(),
          });
        }
        const finalAnswer = answer;
        if (!finalAnswer) throw new Error("ASSISTANT_RESPONSE_MISSING");
        try {
          await retryTransient(
            () => this.telegram.send(input.chatId, finalAnswer),
            isTransient,
          );
        } catch (error) {
          await this.observability?.recordFailure({
            stage: "delivery",
            error,
            updateId: input.updateId,
            userId: input.userId,
          });
          throw error;
        }
        await this.checkpoint(input.userId, {
          updateId: input.updateId,
          telegramUserId: input.userId,
          stage: "delivery_complete",
          updatedAt: new Date().toISOString(),
        });
      } finally {
        clearInterval(typingRefresh);
      }
    });
  }
}
