import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readModelConfig,
  readSandboxConfig,
  readTelegramConfig,
} from "../config";
import { ensureSandbox } from "../sandbox/controller";
import { installWorker, invokeWorker } from "../sandbox/transport";
import { uuidV7 } from "../../shared/ids";
import type { TelegramInput } from "./input";

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");

/** Dispatches only the minimized Telegram input and operation-required secrets. */
export async function dispatchTelegramInput(input: TelegramInput) {
  const telegram = readTelegramConfig();
  const model = readModelConfig();
  const sandbox = await ensureSandbox(readSandboxConfig());
  const workerPath = await installWorker(
    sandbox,
    await readFile(workerSourcePath),
  );
  return invokeWorker(
    sandbox,
    workerPath,
    {
      contractVersion: 1,
      correlationId: uuidV7(),
      operation: "telegramTurn",
      payload: { input },
    },
    {
      TELEGRAM_BOT_TOKEN: telegram.TELEGRAM_BOT_TOKEN,
      DEEPSEEK_API_KEY: model.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: model.DEEPSEEK_BASE_URL,
      ASSISTANT_SYSTEM_PROMPT: model.ASSISTANT_SYSTEM_PROMPT,
      DEEPSEEK_THINKING_ENABLED: String(model.DEEPSEEK_THINKING_ENABLED),
      DEEPSEEK_REASONING_EFFORT: model.DEEPSEEK_REASONING_EFFORT,
      DEEPSEEK_INPUT_PRICE_PER_MILLION: String(
        model.DEEPSEEK_INPUT_PRICE_PER_MILLION,
      ),
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: String(
        model.DEEPSEEK_OUTPUT_PRICE_PER_MILLION,
      ),
    },
  );
}
