import type {
  CapabilityRequest,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RoutingDecision,
} from "../../shared/contracts";
import { uuidV7 } from "../../shared/ids";
import { calculateCost } from "../model/usage";
import type {
  ConversationService,
  Message,
  UserProfile,
} from "../conversations/service";
import { handleCommand } from "../commands";
import { LockCoordinator } from "../locks/coordinator";
import { UpdateRepository } from "../updates/repository";
import type { TelegramClient } from "../telegram/client";
import type { TelegramInput } from "../../server/telegram/input";
import { retryTransient } from "../model/retry";
import type { UpdateState } from "../updates/state-machine";
import type { SkillResolver } from "../skills/resolver";
import type { RequestRouter } from "../model/deepseek-router";
import type { RouterRunMetadata } from "../model/deepseek-router";
import type { CapabilityRegistry } from "../capabilities/registry";
import {
  containsInternalProtocol,
  SAFE_OUTPUT_FALLBACK,
} from "../model/deepseek";

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
    private telegram: Pick<TelegramClient, "typing" | "send"> &
      Partial<Pick<TelegramClient, "acknowledgeCallback">>,
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
    private generalCapabilities: CapabilityRequest[] = [],
    private router?: RequestRouter,
    private capabilityRegistry?: CapabilityRegistry,
    private turnTimeoutMs = 60_000,
    private routing: {
      mode: "shadow" | "enforced";
      minimumConfidence?: number;
    } = { mode: "enforced" },
  ) {}
  private checkpoint(userId: string, state: UpdateState) {
    return this.locks.withMutation(() => this.updates.save(state), userId);
  }
  private async validateFinalAnswer(
    answer: string | undefined,
    originalRequest: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{ answer: string; recovered?: ModelResponse }> {
    if (answer?.trim() && !containsInternalProtocol(answer)) return { answer };

    try {
      const context = await this.conversations.context(userId, this.prompt);
      const safeHistory = context.messages.filter(
        (message, index, messages) =>
          message.role !== "system" &&
          index !== messages.length - 1 &&
          message.content.trim().length > 0 &&
          !containsInternalProtocol(message.content),
      );
      const recovered = await this.model.generate({
        executionMode: "direct",
        messages: [
          { role: "system", content: this.prompt },
          ...safeHistory,
          { role: "user", content: originalRequest },
        ],
        generalCapabilities: [],
        signal,
      });
      if (
        recovered.content.trim() &&
        !containsInternalProtocol(recovered.content)
      )
        return { answer: recovered.content, recovered };
    } catch {
      // Recovery is best-effort. Provider errors must not make unsafe output
      // eligible for delivery.
    }
    return { answer: SAFE_OUTPUT_FALLBACK };
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
    if (input.kind === "callback") {
      // Telegram requires a prompt answer to stop the client's progress UI.
      // The controller-side confirmation service performs the durable CAS; the
      // worker must never reinterpret opaque callback data as conversation text.
      await this.telegram.acknowledgeCallback?.(input.callbackQueryId);
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
      const command = handleCommand(
        input.text,
        this.skills?.commandCatalog(input.userId),
        input.userId,
      );
      const unknownCommand = /^\s*\/[A-Za-z0-9_]+(?:@\S+)?(?:\s|$)/.test(
        input.text,
      );
      const deterministic =
        command?.kind === "reply"
          ? command.text
          : !command && unknownCommand
            ? "Unknown command. Use /help to see available commands."
            : undefined;
      const routedText =
        command?.kind === "invoke"
          ? command.invocation.request
          : command?.kind === "fallback"
            ? command.request
            : input.text;
      if (input.text === "/new")
        await this.conversations.newConversation(input.userId);
      let requestMessageId: string | null = null;
      if (!existing || existing.stage === "received") {
        const userMessage = await this.conversations.add(
          input.userId,
          "user",
          routedText,
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
      const turnController = new AbortController();
      const turnTimer = setTimeout(
        () => turnController.abort(new Error("TURN_TIMEOUT")),
        this.turnTimeoutMs,
      );
      let answer = existing?.assistantId
        ? (await this.conversations.message(existing.assistantId))?.text
        : undefined;
      try {
        if (!answer) {
          let generated: ModelResponse | undefined;
          let latencyMs = 0;
          let resolution: ReturnType<SkillResolver["resolve"]> | undefined;
          let routedCapabilities = this.generalCapabilities;
          let executionMode: ModelRequest["executionMode"] = "direct";
          let preparedContext: ModelRequest | undefined;
          const routerRuns: RouterRunMetadata[] = [];
          let shadowRouteKind: string | undefined;
          let fallbackReason:
            | "no_skill_match"
            | "skill_not_found"
            | "skill_unavailable"
            | "model_output_recovery"
            | undefined;
          try {
            if (deterministic) answer = deterministic;
            else {
              if (!command && this.router && this.routing.mode === "shadow") {
                const shadowContext = await this.conversations.context(
                  input.userId,
                  this.prompt,
                );
                try {
                  const routed = this.router.routeWithMetadata
                    ? await this.router.routeWithMetadata({
                        request: routedText,
                        conversationContext: shadowContext.messages
                          .filter(
                            (
                              message,
                            ): message is typeof message & {
                              role: "user" | "assistant";
                            } => message.role !== "system",
                          )
                          .slice(0, -1)
                          .slice(-20),
                        authorizedSkills:
                          this.skills?.routingCatalog(input.userId) ?? [],
                        availableTools: this.capabilityRegistry
                          ? this.capabilityRegistry.generalRequests()
                          : [...this.generalCapabilities],
                        signal: turnController.signal,
                      })
                    : {
                        decision: await this.router.route({
                          request: routedText,
                          conversationContext: [],
                          authorizedSkills:
                            this.skills?.routingCatalog(input.userId) ?? [],
                          availableTools: this.capabilityRegistry
                            ? this.capabilityRegistry.generalRequests()
                            : [...this.generalCapabilities],
                          signal: turnController.signal,
                        }),
                        run: { latencyMs: 0 },
                      };
                  shadowRouteKind = routed.decision.kind;
                  routerRuns.push({
                    ...routed.run,
                    routingMode: "shadow",
                    fallbackReason:
                      this.routing.minimumConfidence !== undefined &&
                      routed.decision.confidence <
                        this.routing.minimumConfidence
                        ? "low_confidence"
                        : routed.run.fallbackReason,
                  });
                } catch (error) {
                  const failed = (error as { run?: RouterRunMetadata }).run;
                  if (failed)
                    routerRuns.push({ ...failed, routingMode: "shadow" });
                }
              }
              if (command?.kind === "fallback") {
                resolution = { kind: "none" as const };
              } else if (command?.kind === "invoke") {
                resolution = this.skills?.resolve(
                  routedText,
                  input.userId,
                  command.invocation.skill.id ?? command.invocation.skill.name,
                );
              } else if (this.router && this.routing.mode === "enforced") {
                preparedContext = await this.conversations.context(
                  input.userId,
                  this.prompt,
                );
                const messages = preparedContext.messages.filter(
                  (
                    message,
                  ): message is typeof message & {
                    role: "user" | "assistant";
                  } => message.role !== "system",
                );
                let skillCatalog =
                  this.skills?.routingCatalog(input.userId) ?? [];
                let toolCatalog = this.capabilityRegistry
                  ? this.capabilityRegistry.generalRequests()
                  : [...this.generalCapabilities];
                resolution = { kind: "none" as const };
                routedCapabilities = [];
                // One initial classification and at most one bounded recovery
                // classification. Invalid IDs are removed before recovery.
                for (
                  let routingAttempt = 0;
                  routingAttempt < 2;
                  routingAttempt++
                ) {
                  let decision: RoutingDecision;
                  try {
                    const routingRequest = {
                      request: routedText,
                      conversationContext: messages.slice(0, -1).slice(-20),
                      authorizedSkills: skillCatalog,
                      availableTools: toolCatalog,
                      signal: turnController.signal,
                    };
                    if (this.router.routeWithMetadata) {
                      const routed = await retryTransient(
                        () => this.router!.routeWithMetadata!(routingRequest),
                        isTransient,
                      );
                      decision = routed.decision;
                      const lowConfidence =
                        this.routing.minimumConfidence !== undefined &&
                        decision.confidence < this.routing.minimumConfidence;
                      routerRuns.push({
                        ...routed.run,
                        routingMode: "enforced",
                        rerouteCount: routingAttempt,
                        ...(lowConfidence
                          ? { fallbackReason: "low_confidence" as const }
                          : {}),
                      });
                      if (lowConfidence) {
                        decision = {
                          kind: "direct",
                          confidence: decision.confidence,
                          rationale: "Below configured confidence threshold",
                        };
                      }
                    } else {
                      decision = await retryTransient(
                        () => this.router!.route(routingRequest),
                        isTransient,
                      );
                    }
                  } catch (error) {
                    const failedRun = (error as { run?: RouterRunMetadata })
                      ?.run;
                    if (failedRun)
                      routerRuns.push({
                        ...failedRun,
                        routingMode: "enforced",
                        rerouteCount: routingAttempt,
                      });
                    if (
                      routingAttempt === 0 &&
                      (error as Error)?.message === "ROUTER_OUTPUT_INVALID"
                    )
                      continue;
                    // Provider failures and timeouts fail safely to the direct
                    // answer path; the sanitized failed run is still recorded.
                    break;
                  }

                  if (decision.kind === "skill") {
                    const current = this.skills?.resolveRouted(
                      decision.selectedSkillId,
                      input.userId,
                    );
                    if (current?.kind === "selected") {
                      resolution = current;
                      executionMode = "selected_skill";
                      break;
                    }
                    skillCatalog = skillCatalog.filter(
                      ({ id }) => id !== decision.selectedSkillId,
                    );
                    if (routingAttempt === 0) continue;
                    break;
                  }
                  if (
                    decision.kind === "tool" ||
                    decision.kind === "web_search_fallback"
                  ) {
                    if (decision.kind === "web_search_fallback") {
                      // Provider-native search stays in this answer request;
                      // it is not routed through the function registry.
                      routedCapabilities = [];
                      executionMode = "forced_web_search";
                      break;
                    }
                    const selectedId = decision.selectedToolId;
                    // Fetch a fresh general catalog at execution time to close
                    // the catalog/authorization race.
                    const currentGeneral = this.capabilityRegistry
                      ? this.capabilityRegistry.generalRequests()
                      : [...this.generalCapabilities];
                    const selected = currentGeneral.filter(
                      ({ id }) => id === selectedId,
                    );
                    if (selected.length === 1) {
                      routedCapabilities = this.capabilityRegistry
                        ? this.capabilityRegistry.requests([selectedId])
                        : selected;
                      executionMode = "selected_tools";
                      break;
                    }
                    toolCatalog = toolCatalog.filter(
                      ({ id }) => id !== selectedId,
                    );
                    if (routingAttempt === 0) continue;
                    break;
                  }
                  if (decision.kind === "ambiguous") {
                    const authorizedIds = new Set([
                      ...skillCatalog.map(({ id }) => id),
                      ...toolCatalog.map(({ id }) => id),
                    ]);
                    const choices = decision.candidateIds.filter((id) =>
                      authorizedIds.has(id),
                    );
                    if (choices.length >= 2) {
                      answer = `I need clarification. Would you like ${choices.join(" or ")}?`;
                      break;
                    }
                    skillCatalog = skillCatalog.filter(({ id }) =>
                      choices.includes(id),
                    );
                    toolCatalog = toolCatalog.filter(({ id }) =>
                      choices.includes(id),
                    );
                    if (routingAttempt === 0) continue;
                    break;
                  }
                  if (decision.kind === "refuse")
                    answer = "I can’t help with that request.";
                  if (decision.kind === "unavailable")
                    answer =
                      "I can’t perform that action because no authorized capability is available, and web search cannot perform it.";
                  // direct and the bounded invalid-selection fallback both
                  // intentionally execute without capabilities.
                  break;
                }
              } else {
                resolution = this.skills?.resolve(routedText, input.userId);
              }
              if (resolution?.kind === "selected")
                executionMode = "selected_skill";
              else if (
                (!this.router || this.routing.mode === "shadow") &&
                routedCapabilities.length
              )
                executionMode = "selected_tools";
              if (this.routing.mode === "shadow" && shadowRouteKind) {
                const existingRoute =
                  resolution?.kind === "selected"
                    ? "skill"
                    : resolution?.kind === "ambiguous"
                      ? "ambiguous"
                      : routedCapabilities.length
                        ? "tool"
                        : "direct";
                for (const run of routerRuns)
                  run.disagreement = shadowRouteKind !== existingRoute;
              }
              if (!resolution || resolution.kind === "none")
                fallbackReason =
                  command?.kind === "fallback"
                    ? command.reason
                    : "no_skill_match";
              if (answer) {
                // The router produced a deterministic clarification or refusal.
              } else if (resolution?.kind === "ambiguous") {
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
                const context =
                  preparedContext ??
                  (await this.conversations.context(input.userId, this.prompt));
                generated = await retryTransient(
                  async () =>
                    this.model.generate({
                      ...context,
                      executionMode,
                      generalCapabilities: routedCapabilities,
                      signal: turnController.signal,
                      ...(resolution?.kind === "selected"
                        ? { skill: resolution.skill }
                        : {}),
                    }),
                  isTransient,
                );
                latencyMs = Date.now() - started;
                if (generated.outputRecovery?.triggered)
                  fallbackReason = "model_output_recovery";
                answer =
                  command?.kind === "fallback"
                    ? `${command.note}\n\n${generated.content}`
                    : generated.content;
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
          const validation = await this.validateFinalAnswer(
            answer,
            routedText,
            input.userId,
            turnController.signal,
          );
          answer = validation.answer;
          if (validation.recovered) {
            generated = validation.recovered;
            fallbackReason = "model_output_recovery";
          }
          const assistant = await this.conversations.add(
            input.userId,
            "assistant",
            answer,
          );
          if (this.accounting)
            for (const routerRun of routerRuns)
              await this.conversations.recordModelRun?.({
                id: uuidV7(),
                runKind: "router",
                userId: input.userId,
                provider: "deepseek",
                model: "deepseek-v4-pro",
                thinkingEnabled: this.accounting.thinkingEnabled,
                effort: "medium",
                status: "completed",
                requestMessageId,
                responseMessageId: null,
                providerRequestId: routerRun.requestId ?? null,
                inputCount: routerRun.usage?.inputTokens ?? null,
                outputCount: routerRun.usage?.outputTokens ?? null,
                inputPricePerMillion:
                  this.accounting.inputPricePerMillion ?? null,
                outputPricePerMillion:
                  this.accounting.outputPricePerMillion ?? null,
                estimatedCost:
                  routerRun.usage &&
                  this.accounting.inputPricePerMillion &&
                  this.accounting.outputPricePerMillion
                    ? calculateCost(
                        routerRun.usage.inputTokens,
                        routerRun.usage.outputTokens,
                        this.accounting.inputPricePerMillion,
                        this.accounting.outputPricePerMillion,
                      ).estimatedCost
                    : null,
                latencyMs: routerRun.latencyMs,
                routingOutcome: routerRun.routeKind ?? null,
                selectedSkillId: routerRun.selectedSkillId ?? null,
                selectedToolId: routerRun.selectedToolId ?? null,
                candidateIds: routerRun.candidateIds ?? [],
                validationOutcome: routerRun.validationOutcome ?? null,
                confidence: routerRun.confidence ?? null,
                routingMode: routerRun.routingMode ?? null,
                rerouteCount: routerRun.rerouteCount ?? 0,
                disagreement: routerRun.disagreement ?? null,
                fallbackReason: routerRun.fallbackReason ?? null,
                createdAt: new Date().toISOString(),
              });
          if (generated && this.accounting)
            await this.conversations.recordModelRun?.({
              id: uuidV7(),
              runKind: "answer",
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
                  : routedCapabilities.map((item) => item.id),
              capabilityAudit: generated.capabilityAudit ?? [],
              routingOutcome:
                resolution?.kind === "selected"
                  ? "skill"
                  : resolution?.kind === "ambiguous"
                    ? "ambiguous"
                    : "general",
              fallbackReason: fallbackReason ?? null,
              outputRecovery: generated.outputRecovery ?? null,
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
        // Revalidate durable responses as well as newly generated ones so a
        // previously stored unsafe payload can never bypass the send boundary.
        const finalValidation = await this.validateFinalAnswer(
          answer,
          routedText,
          input.userId,
          turnController.signal,
        );
        const finalAnswer = finalValidation.answer;
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
        clearTimeout(turnTimer);
        turnController.abort();
        clearInterval(typingRefresh);
      }
    });
  }
}
