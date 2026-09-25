import { readFile, writeFile } from "node:fs/promises";
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

const ROOT = "/workspace/telegram-agent";

async function telegramTurn(payload: Record<string, unknown>) {
  const input = telegramInputSchema.parse(payload.input);
  await initializeLayout(ROOT);
  const locks = new LockCoordinator(ROOT);
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
  );
  await turn.handle(input);
  return { terminal: true };
}

async function createExport() {
  return exportData({ root: ROOT });
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
  const data =
    request.operation === "telegramTurn"
      ? await telegramTurn(request.payload)
      : request.operation === "export"
        ? await createExport()
        : {};
  const response = workerResponseSchema.parse({
    contractVersion: 1,
    correlationId: request.correlationId,
    ok: true,
    data,
  });
  await writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
}

void main();
