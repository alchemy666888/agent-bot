import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { workerRequestSchema, workerResponseSchema } from "../shared/contracts";
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
) {
  const input = telegramInputSchema.parse(payload.input);
  await initializeLayout(ROOT);
  const locks = new LockCoordinator(ROOT);
  const errors = new DurableErrorService(ROOT, locks);
  const capabilities = createCapabilityRegistry(fetch, {
    apiKey: requiredEnv("DEEPSEEK_API_KEY"),
    baseUrl: requiredEnv("DEEPSEEK_BASE_URL"),
  });
  const catalog = skillCatalogSnapshotSchema.parse(payload.skillCatalog);
  const skills = new SkillResolver(
    capabilities,
    process.env.SKILLS_ENABLED === "false" ? [] : catalog.skills,
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
    requiredEnv("ASSISTANT_SYSTEM_PROMPT"),
    {
      correlationId,
      recordFailure: (failure) => errors.record({ correlationId, ...failure }),
    },
    {
      inputPricePerMillion: process.env.DEEPSEEK_INPUT_PRICE_PER_MILLION,
      outputPricePerMillion: process.env.DEEPSEEK_OUTPUT_PRICE_PER_MILLION,
      thinkingEnabled: process.env.DEEPSEEK_THINKING_ENABLED !== "false",
    },
    skills,
    capabilities.generalRequests(),
    new DeepSeekRouter(
      {
        apiKey: requiredEnv("DEEPSEEK_API_KEY"),
        baseUrl: requiredEnv("DEEPSEEK_BASE_URL"),
        thinking: requiredEnv("DEEPSEEK_THINKING_ENABLED") === "true",
      },
      fetch,
    ),
    capabilities,
    optionalPositiveInteger("SKILL_EXECUTION_TIMEOUT_MS") ?? 60_000,
  );
  await turn.handle(input);
  return { terminal: true };
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("WORKER_CONFIGURATION_INVALID");
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("WORKER_CONFIGURATION_INVALID");
  return parsed;
}

async function main() {
  const [, , operation, requestPath, responsePath] = process.argv;
  if (!operation || !requestPath || !responsePath)
    throw new Error("INVALID_WORKER_INVOCATION");
  const request = workerRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
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
            ? await telegramTurn(request.payload, request.correlationId)
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
          contractVersion: 1,
          correlationId: request.correlationId,
          ok: false,
          error: safeError(failure, "INTERNAL_ERROR", failureStage),
        }
      : {
          contractVersion: 1,
          correlationId: request.correlationId,
          ok: true,
          data,
        },
  );
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
}

void main();
