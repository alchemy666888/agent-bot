import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { workerRequestSchema, workerResponseSchema } from "../shared/contracts";
import { authorizedSkillCatalogSchema } from "../shared/contracts";
import { telegramInputSchema } from "../server/telegram/input";
import { LockCoordinator } from "./locks/coordinator";
import { UpdateRepository } from "./updates/repository";
import { DurableConversationService } from "./conversations/durable-service";
import { DeepSeekProvider } from "./model/deepseek";
import { DeepSeekRouter } from "./model/deepseek-router";
import { TelegramClient } from "./telegram/client";
import { TelegramTurn } from "./orchestration/telegram-turn";
import { initializeLayout } from "./persistence/layout";
import { exportData } from "./export/service";
import { DurableErrorService } from "./errors/service";
import { QueryService } from "./queries/service";
import { openPersistenceStore } from "../shared/postgres/controller-log";
import { safeError } from "../shared/logger";
import { bindPersistenceSession } from "./persistence/database-sync";
import { writeWorkerLog } from "./observability/worker-log";
import { createCapabilityRegistry } from "./capabilities";
import { SkillResolver } from "./skills/resolver";
import { skillCatalogSnapshotSchema } from "./skills/schemas";
import type { PromptBundle } from "../shared/contracts/prompt";
import type { DegradationNotice } from "../shared/contracts/worker";
import { compiledEmergencyBundle, parsePromptBundle } from "./prompts/bundle";
import { detectPromptChangeProposal } from "./prompts/proposal";

const ROOT = process.env.TELEGRAM_AGENT_ROOT ?? "/tmp/telegram-agent";

const queryPayloadSchema = z
  .object({
    view: z.enum([
      "overview",
      "users",
      "conversations",
      "messages",
      "model-runs",
      "errors",
      "conversation",
    ]),
    search: z.string().max(200).optional(),
    page: z.number().int().positive().optional(),
    id: z.string().min(1).optional(),
  })
  .strict();

async function telegramTurn(
  payload: Record<string, unknown>,
  correlationId: string,
  promptBundle?: PromptBundle,
  rawTelegramInput?: string,
  degradationNotices: readonly DegradationNotice[] = [],
) {
  const input = telegramInputSchema.parse(payload.input);
  // Ignored updates have no model work. Building a turn here required the
  // emergency prompt, which the sandbox command does not inherit, so every
  // non-text webhook failed WORKER_CONFIGURATION_INVALID and Telegram retried.
  if (input.kind === "ignored") return { terminal: true };
  if (
    rawTelegramInput !== undefined &&
    input.kind === "text" &&
    input.text !== rawTelegramInput
  )
    throw new Error("RAW_TELEGRAM_INPUT_MISMATCH");
  await initializeLayout(ROOT);
  const locks = new LockCoordinator(ROOT);
  const errors = new DurableErrorService(ROOT, locks);
  const capabilities = createCapabilityRegistry();
  const catalog = skillCatalogSnapshotSchema.parse(payload.skillCatalog);
  // Preserve the repository-filtered snapshot independently of the resolver.
  // Parsing again applies the tighter model-context count and byte limits.
  const authorizedSkillCatalog = authorizedSkillCatalogSchema.parse(catalog);
  const bundle = promptBundle
    ? parsePromptBundle(promptBundle)
    : compiledEmergencyBundle(requiredEnv("ASSISTANT_SYSTEM_PROMPT"));
  const skills = new SkillResolver(
    capabilities,
    envValue("SKILLS_ENABLED") === "false" ? [] : catalog.skills,
  );
  const routingEnabled = optionalStrictBoolean(
    "DEEPSEEK_ROUTING_ENABLED",
    false,
  );
  const routingMode = optionalRoutingMode();
  const routerTimeoutMs = boundedInteger(
    "DEEPSEEK_ROUTER_TIMEOUT_MS",
    250,
    30_000,
    3_000,
  );
  const routerMinimumConfidence = optionalBoundedNumber(
    "DEEPSEEK_ROUTER_MIN_CONFIDENCE",
    0,
    1,
  );
  const turn = new TelegramTurn(
    locks,
    new UpdateRepository(ROOT),
    new DurableConversationService(ROOT, locks),
    new DeepSeekProvider(
      {
        apiKey: requiredEnv("DEEPSEEK_API_KEY"),
        baseUrl: requiredEnv("DEEPSEEK_BASE_URL"),
        thinking: requiredEnv("DEEPSEEK_THINKING_ENABLED") === "true",
        maxToolCalls: optionalPositiveInteger("SKILL_MAX_TOOL_STEPS"),
      },
      fetch,
      capabilities,
    ),
    new TelegramClient(requiredEnv("TELEGRAM_BOT_TOKEN")),
    bundle,
    {
      correlationId,
      recordFailure: (failure) => errors.record({ correlationId, ...failure }),
    },
    {
      inputPricePerMillion: envValue("DEEPSEEK_INPUT_PRICE_PER_MILLION"),
      outputPricePerMillion: envValue("DEEPSEEK_OUTPUT_PRICE_PER_MILLION"),
      thinkingEnabled: envValue("DEEPSEEK_THINKING_ENABLED") !== "false",
    },
    skills,
    capabilities.generalRequests(),
    routingEnabled
      ? new DeepSeekRouter(
          {
            apiKey: requiredEnv("DEEPSEEK_API_KEY"),
            baseUrl: requiredEnv("DEEPSEEK_BASE_URL"),
            thinking: requiredEnv("DEEPSEEK_THINKING_ENABLED") === "true",
            timeoutMs: routerTimeoutMs,
          },
          fetch,
        )
      : undefined,
    capabilities,
    optionalPositiveInteger("SKILL_EXECUTION_TIMEOUT_MS") ?? 60_000,
    { mode: routingMode, minimumConfidence: routerMinimumConfidence },
    Object.freeze({
      catalogToken: authorizedSkillCatalog.catalogToken,
      skills: [...authorizedSkillCatalog.skills],
    }),
    degradationNotices,
  );
  await turn.handle(input);
  const proposal =
    input.kind === "text" && input.chatScope !== "group"
      ? detectPromptChangeProposal(input.text, bundle)
      : null;
  return { terminal: true, ...(proposal ? { proposal } : {}) };
}

async function createExport() {
  return exportData({ root: ROOT });
}

async function recover(payload: Record<string, unknown>) {
  if (payload.relativePath !== "data/live-preview-marker.txt") return {};
  return {
    text: await readFile(join(ROOT, "data/live-preview-marker.txt"), "utf8"),
  };
}

async function query(payload: Record<string, unknown>) {
  const parsed = queryPayloadSchema.parse(payload);
  const service = new QueryService(ROOT);
  const input = { search: parsed.search ?? "", page: parsed.page ?? 1 };
  if (parsed.view === "overview") return service.overview();
  if (parsed.view === "conversation") {
    if (!parsed.id) throw new Error("INVALID_QUERY");
    return service.conversation(parsed.id, input);
  }
  return service.list(parsed.view, input);
}

function invalidWorkerConfiguration(name: string): never {
  throw Object.assign(new Error("WORKER_CONFIGURATION_INVALID"), {
    code: name,
  });
}

/** Blank and whitespace match the server: they are unset, not invalid. */
function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = envValue(name);
  if (!value) invalidWorkerConfiguration(name);
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const value = envValue(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    invalidWorkerConfiguration(name);
  return parsed;
}

function optionalStrictBoolean(name: string, fallback: boolean): boolean {
  const value = envValue(name);
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") invalidWorkerConfiguration(name);
  return value === "true";
}

function optionalRoutingMode(): "shadow" | "enforced" {
  const value = envValue("DEEPSEEK_ROUTING_MODE") ?? "shadow";
  if (value !== "shadow" && value !== "enforced")
    invalidWorkerConfiguration("DEEPSEEK_ROUTING_MODE");
  return value;
}

function boundedInteger(
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = envValue(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    invalidWorkerConfiguration(name);
  return parsed;
}

function optionalBoundedNumber(
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = envValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    invalidWorkerConfiguration(name);
  return parsed;
}

async function main() {
  const [, , operation, requestPath, responsePath] = process.argv;
  if (!operation || !requestPath || !responsePath)
    throw new Error("INVALID_WORKER_INVOCATION");
  const rawRequest = JSON.parse(await readFile(requestPath, "utf8"));
  // Parse/detach v2 prompt data at ingress, before any turn object or service
  // can be constructed. The full request parse additionally rejects absence.
  if ((rawRequest as { contractVersion?: unknown }).contractVersion === 2)
    parsePromptBundle((rawRequest as { promptBundle?: unknown }).promptBundle);
  const request = workerRequestSchema.parse(rawRequest);
  if (request.operation !== operation) throw new Error("OPERATION_MISMATCH");
  const started = Date.now();
  let data: unknown;
  let failure: unknown;
  let failureStage = "bootstrap";
  try {
    const store = openPersistenceStore();
    failureStage = "persistence-sync";
    await bindPersistenceSession(ROOT, store, async () => {
      failureStage = "operation";
      try {
        data =
          request.operation === "telegramTurn"
            ? await telegramTurn(
                request.payload,
                request.correlationId,
                request.contractVersion === 2
                  ? request.promptBundle
                  : undefined,
                request.contractVersion === 2
                  ? request.rawTelegramInput
                  : undefined,
                request.contractVersion === 2
                  ? request.degradationNotices
                  : undefined,
              )
            : request.operation === "export"
              ? await createExport()
              : request.operation === "query"
                ? await query(request.payload)
                : request.operation === "recover"
                  ? await recover(request.payload)
                  : {};
      } catch (error) {
        failure = error;
      }
      if (!failure) failureStage = "worker-log";
      try {
        await writeWorkerLog(
          ROOT,
          {
            correlationId: request.correlationId,
            component: "worker",
            operation: request.operation,
            stage: "complete",
            result: failure ? "failure" : "success",
            durationMs: Date.now() - started,
            ...(request.contractVersion === 2 &&
            request.degradationNotices.length
              ? {
                  metadata: {
                    degradationNotices: [
                      ...new Set(request.degradationNotices),
                    ],
                  },
                }
              : {}),
            ...(failure ? { code: safeError(failure).code } : {}),
          },
          store,
        );
      } catch (error) {
        if (!failure) failure = error;
      }
      if (failure) throw failure;
    });
  } catch (error) {
    failure = error;
  }
  const response = workerResponseSchema.parse(
    failure
      ? {
          contractVersion: request.contractVersion,
          correlationId: request.correlationId,
          ok: false,
          error: safeError(failure, "INTERNAL_ERROR", failureStage),
        }
      : {
          contractVersion: request.contractVersion,
          correlationId: request.correlationId,
          ok: true,
          data,
        },
  );
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
}

void main();
