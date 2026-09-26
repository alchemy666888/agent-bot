import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { workerRequestSchema, workerResponseSchema } from "../shared/contracts";
import { telegramInputSchema } from "../server/telegram/input";
import { LockCoordinator } from "./locks/coordinator";
import { UpdateRepository } from "./updates/repository";
import { DurableConversationService } from "./conversations/durable-service";
import { DeepSeekProvider } from "./model/deepseek";
import { TelegramClient } from "./telegram/client";
import { TelegramTurn } from "./orchestration/telegram-turn";
import { initializeLayout } from "./persistence/layout";
import { exportData } from "./export/service";
import { DurableErrorService } from "./errors/service";
import { QueryService } from "./queries/service";
import { logStructured, safeError } from "../shared/logger";

const ROOT = process.env.TELEGRAM_AGENT_ROOT ?? "/workspace/telegram-agent";

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
  const turn = new TelegramTurn(
    locks,
    new UpdateRepository(ROOT),
    new DurableConversationService(ROOT, locks),
    new DeepSeekProvider({
      apiKey: requiredEnv("DEEPSEEK_API_KEY"),
      baseUrl: requiredEnv("DEEPSEEK_BASE_URL"),
      thinking: requiredEnv("DEEPSEEK_THINKING_ENABLED") === "true",
    }),
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
  );
  await turn.handle(input);
  return { terminal: true };
}

async function createExport() {
  return exportData({ root: ROOT });
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

async function main() {
  const [, , operation, requestPath, responsePath] = process.argv;
  if (!operation || !requestPath || !responsePath)
    throw new Error("INVALID_WORKER_INVOCATION");
  const request = workerRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  if (request.operation !== operation) throw new Error("OPERATION_MISMATCH");
  const started = Date.now();
  let data;
  try {
    data =
      request.operation === "telegramTurn"
        ? await telegramTurn(request.payload, request.correlationId)
        : request.operation === "export"
          ? await createExport()
          : request.operation === "query"
            ? await query(request.payload)
            : {};
    logStructured({
      correlationId: request.correlationId,
      component: "worker",
      operation: request.operation,
      stage: "complete",
      result: "success",
      durationMs: Date.now() - started,
    });
  } catch (error) {
    logStructured({
      correlationId: request.correlationId,
      component: "worker",
      operation: request.operation,
      stage: "complete",
      result: "failure",
      durationMs: Date.now() - started,
      code: safeError(error).code,
    });
    throw error;
  }
  const response = workerResponseSchema.parse({
    contractVersion: 1,
    correlationId: request.correlationId,
    ok: true,
    data,
  });
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
}

void main();
