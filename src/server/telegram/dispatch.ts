import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readModelConfig,
  readSandboxConfig,
  readTelegramConfig,
  readGitHubConfig,
} from "../config";
import { ensureSandbox } from "../sandbox/controller";
import { installWorker, invokeWorker } from "../sandbox/transport";
import { databaseProcessEnv } from "../../shared/postgres/config";
import { uuidV7 } from "../../shared/ids";
import type { TelegramInput } from "./input";
import { createGitHubSkillsClient } from "../github/skills-client";
import { GitHubSkillRepository } from "../github/skill-repository";

const MAX_SKILL_CATALOG_BYTES = 4 * 1024 * 1024;

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");

/** Dispatches only the minimized Telegram input and operation-required secrets. */
export async function dispatchTelegramInput(
  input: TelegramInput,
  correlationId = uuidV7(),
) {
  const telegram = readTelegramConfig();
  const model = readModelConfig();
  const github = readGitHubConfig();
  const skillCatalog = await new GitHubSkillRepository(
    createGitHubSkillsClient({
      connector: github.GITHUB_CONNECTOR,
      owner: github.GITHUB_SKILLS_OWNER,
      repository: github.GITHUB_SKILLS_REPO,
      branch: github.GITHUB_SKILLS_BRANCH,
      prefix: github.GITHUB_SKILLS_PREFIX,
    }),
  ).loadCatalogSnapshot();
  if (
    Buffer.byteLength(JSON.stringify(skillCatalog), "utf8") >
    MAX_SKILL_CATALOG_BYTES
  )
    throw new Error("SKILL_CATALOG_TOO_LARGE");
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
      correlationId,
      operation: "telegramTurn",
      payload: { input, skillCatalog },
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
      ...databaseProcessEnv(),
    },
  );
}
