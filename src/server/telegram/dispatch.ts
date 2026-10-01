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
import { logStructured, safeError } from "../../shared/logger";
import type { GitHubClientEvent } from "../github/skills-client";
import type { SkillRepositoryEvent } from "../github/skill-repository";

const MAX_SKILL_CATALOG_BYTES = 4 * 1024 * 1024;

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");

type SkillCatalog = Awaited<
  ReturnType<GitHubSkillRepository["loadCatalogSnapshot"]>
>;

const EMPTY_SKILL_CATALOG: SkillCatalog = {
  commitSha: "0".repeat(40),
  skills: [],
};

/**
 * Skills are an optional enhancement to an ordinary Telegram conversation.
 * Fail closed (with no skills) when GitHub Connect is unavailable so a
 * connector outage cannot prevent the bot from answering normal messages.
 */
export async function loadSkillCatalogOrEmpty(
  load: () => Promise<SkillCatalog>,
  correlationId: string,
): Promise<SkillCatalog> {
  const started = Date.now();
  try {
    return await load();
  } catch (error) {
    const failure = safeError(error, "GITHUB_CATALOG_UNAVAILABLE", "catalog");
    logStructured({
      correlationId,
      component: "controller",
      operation: "skill.catalog_load",
      stage: "skill-repository",
      result: "degraded",
      durationMs: Date.now() - started,
      code: "GITHUB_CATALOG_UNAVAILABLE",
      ...(failure.diagnostic ? { metadata: failure.diagnostic } : {}),
    });
    return EMPTY_SKILL_CATALOG;
  }
}

function auditGitHubEvent(
  correlationId: string,
  event: GitHubClientEvent | SkillRepositoryEvent,
) {
  logStructured({
    correlationId,
    component: "controller",
    operation: event.operation,
    stage: "skill-repository",
    result:
      event.result === "denied" || event.result === "failure"
        ? "failure"
        : event.result,
    durationMs: event.durationMs,
    ...(event.code ? { code: event.code } : {}),
    metadata: {
      ...("actorTelegramUserId" in event && event.actorTelegramUserId
        ? { actorTelegramUserId: event.actorTelegramUserId }
        : {}),
      ...("skillId" in event && event.skillId
        ? { skillId: event.skillId }
        : {}),
      ...("draftId" in event && event.draftId
        ? { draftId: event.draftId }
        : {}),
      ...(event.commitSha ? { commitSha: event.commitSha } : {}),
      ...(event.pullRequestNumber
        ? { pullRequestNumber: event.pullRequestNumber }
        : {}),
    },
  });
}

/** Dispatches only the minimized Telegram input and operation-required secrets. */
export async function dispatchTelegramInput(
  input: TelegramInput,
  correlationId = uuidV7(),
) {
  const telegram = readTelegramConfig();
  const model = readModelConfig();
  const github = readGitHubConfig();
  // Non-text updates never enter the skill invocation path. Use the only
  // authenticated Telegram identity available for text turns.
  const skillCatalog =
    input.kind === "text"
      ? await loadSkillCatalogOrEmpty(
          () =>
            new GitHubSkillRepository(
              createGitHubSkillsClient(
                {
                  connector: github.GITHUB_CONNECTOR,
                  owner: github.GITHUB_SKILLS_OWNER,
                  repository: github.GITHUB_SKILLS_REPO,
                  branch: github.GITHUB_SKILLS_BRANCH,
                  prefix: github.GITHUB_SKILLS_PREFIX,
                },
                { audit: (event) => auditGitHubEvent(correlationId, event) },
              ),
              { audit: (event) => auditGitHubEvent(correlationId, event) },
            ).loadCatalogSnapshot({ telegramUserId: input.userId }),
          correlationId,
        )
      : EMPTY_SKILL_CATALOG;
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
