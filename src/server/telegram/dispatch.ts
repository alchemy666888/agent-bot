import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import {
  readModelConfig,
  readSandboxConfig,
  readTelegramConfig,
  readGitHubConfig,
  readPromptConfig,
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
import { TelegramClient } from "../../worker/telegram/client";
import { derivePromptUserKey } from "../prompts/identity";
import { PromptService } from "../prompts/service";
import {
  parseConfirmationCallback,
  type PromptConfirmationService,
} from "../prompts/confirmation";
import { GitHubContentsTransport } from "../github/contents-client";
import { GitHubPromptStore } from "../prompts/github-store";
import { PromptSnapshotCache } from "../prompts/cache";
import { PostgresPromptRepository } from "../prompts/postgres";
import { readDatabaseConfig } from "../../shared/postgres/config";
import { postgresPoolConfig } from "../../shared/postgres/client";
import { PromptMetadataRouter } from "../../worker/prompts/router";

const MAX_SKILL_CATALOG_BYTES = 4 * 1024 * 1024;
export const MAX_WORKER_CONTEXT_BYTES = MAX_SKILL_CATALOG_BYTES;

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");

type SkillCatalog = Awaited<
  ReturnType<GitHubSkillRepository["loadCatalogSnapshot"]>
>;

const EMPTY_SKILL_CATALOG: SkillCatalog = {
  commitSha: "0".repeat(40),
  skills: [],
};

type DispatchPromptServices = {
  resolve(input: {
    userKey: string;
    text: string;
    language?: string;
    correlationId?: string;
  }): ReturnType<PromptService["resolve"]>;
  confirmation?: Pick<PromptConfirmationService, "respond">;
};

let promptServices: DispatchPromptServices | undefined;
let repositoryPromptServices: DispatchPromptServices | undefined;

/** Installs trusted, repository-backed services without putting their authority in the worker. */
export function installDispatchPromptServices(
  services?: DispatchPromptServices,
) {
  promptServices = services;
}

function emergencyPromptService(systemPrompt: string): DispatchPromptServices {
  const service = new PromptService({
    get: async () => ({
      source: "compiled_emergency" as const,
      snapshot: null,
      emergencySystemPrompt: systemPrompt,
    }),
  });
  return { resolve: (input) => service.resolve(input) };
}

function configuredPromptService(
  config: ReturnType<typeof readPromptConfig>,
  model: ReturnType<typeof readModelConfig>,
): DispatchPromptServices {
  if (!config.PROMPT_HIERARCHY_ENABLED)
    return emergencyPromptService(model.ASSISTANT_SYSTEM_PROMPT);
  if (repositoryPromptServices) return repositoryPromptServices;

  const database = readDatabaseConfig();
  const repository = new PostgresPromptRepository(
    new Pool(postgresPoolConfig(database.DATABASE_URL, database.AIVEN_PG_CA)),
  );
  const identity = {
    owner: config.GITHUB_PROMPTS_OWNER as string,
    name: config.GITHUB_PROMPTS_REPO as string,
    prefix: config.GITHUB_PROMPTS_PREFIX as string,
    branch: config.GITHUB_PROMPTS_BRANCH as string,
  };
  const store = new GitHubPromptStore(
    new GitHubContentsTransport({
      connector: config.GITHUB_CONNECTOR as string,
      owner: identity.owner,
      repository: identity.name,
    }),
    { branch: identity.branch, prefix: identity.prefix },
  );
  const service = new PromptService(
    new PromptSnapshotCache(store, repository, identity),
    {
      routerEnabled: config.PROMPT_ROUTER_ENABLED,
      confidenceThreshold: config.PROMPT_ROUTER_CONFIDENCE_THRESHOLD as number,
      router: new PromptMetadataRouter({
        apiKey: model.DEEPSEEK_API_KEY,
        baseUrl: model.DEEPSEEK_BASE_URL,
        timeoutMs: model.DEEPSEEK_ROUTER_TIMEOUT_MS,
      }),
    },
  );
  const emergency = emergencyPromptService(model.ASSISTANT_SYSTEM_PROMPT);
  repositoryPromptServices = {
    resolve: async (input) => {
      try {
        return await service.resolve(input);
      } catch (error) {
        const failure = safeError(
          error,
          "PROMPT_REPOSITORY_UNAVAILABLE",
          "prompt",
        );
        logStructured({
          correlationId: input.correlationId ?? uuidV7(),
          component: "controller",
          operation: "prompt.resolve",
          stage: "prompt-repository",
          result: "degraded",
          code: failure.code,
        });
        return emergency.resolve(input);
      }
    },
  };
  return repositoryPromptServices;
}

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
      ...("skillId" in event && event.skillId
        ? { skillId: event.skillId }
        : {}),
      ...("draftId" in event && event.draftId
        ? { draftId: event.draftId }
        : {}),
      ...(event.commitSha
        ? { commitPrefix: event.commitSha.slice(0, 12) }
        : {}),
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
  const promptConfig = readPromptConfig();
  const client = new TelegramClient(telegram.TELEGRAM_BOT_TOKEN);
  if (input.kind === "callback") {
    // Capabilities are consumed only by the trusted confirmation coordinator.
    // They are never copied into a worker request or model-visible history.
    const callback = parseConfirmationCallback(input.data);
    if (
      callback &&
      promptServices?.confirmation &&
      promptConfig.PROMPT_USER_KEY_SECRET
    ) {
      const result = await promptServices.confirmation.respond({
        actor: {
          canonicalId: input.userId,
          userKey: derivePromptUserKey(
            promptConfig.PROMPT_USER_KEY_SECRET as string,
            input.userId,
          ),
        },
        chatId: input.chatId,
        decision: callback.decision,
        nonce: callback.nonce,
      });
      if (result.prompt)
        await client.send(
          input.chatId,
          result.prompt.text,
          result.prompt.buttons,
        );
    }
    await client.acknowledgeCallback(input.callbackQueryId);
    return {
      contractVersion: 1 as const,
      correlationId,
      ok: true as const,
      data: { acknowledged: true },
    };
  }
  const model = readModelConfig();
  const services =
    promptServices ?? configuredPromptService(promptConfig, model);
  if (input.kind !== "text") {
    // Preserve the legacy worker behavior for non-model updates while keeping
    // prompt resolution and identity material out of that path.
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
        payload: { input, skillCatalog: EMPTY_SKILL_CATALOG },
      },
      workerEnvironment(telegram.TELEGRAM_BOT_TOKEN, model),
    );
  }

  // Resolve identity and freeze exactly one bundle before any sandbox exists.
  const userKey = promptConfig.PROMPT_HIERARCHY_ENABLED
    ? derivePromptUserKey(
        promptConfig.PROMPT_USER_KEY_SECRET as string,
        input.userId,
      )
    : "u1_" + "A".repeat(43);
  const promptBundle = await services.resolve({
    userKey,
    text: input.text,
    correlationId,
    ...(input.languageCode ? { language: input.languageCode } : {}),
  });
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
  const promptBytes = Buffer.byteLength(JSON.stringify(promptBundle), "utf8");
  const skillBytes = Buffer.byteLength(JSON.stringify(skillCatalog), "utf8");
  if (
    skillBytes > MAX_SKILL_CATALOG_BYTES ||
    promptBytes + skillBytes > MAX_WORKER_CONTEXT_BYTES
  )
    throw new Error("WORKER_CONTEXT_TOO_LARGE");
  const sandbox = await ensureSandbox(readSandboxConfig());
  const workerPath = await installWorker(
    sandbox,
    await readFile(workerSourcePath),
  );
  return invokeWorker(
    sandbox,
    workerPath,
    {
      contractVersion: 2,
      correlationId,
      operation: "telegramTurn",
      payload: { input, skillCatalog },
      promptBundle,
      rawTelegramInput: input.text,
    },
    workerEnvironment(telegram.TELEGRAM_BOT_TOKEN, model),
  );
}

function workerEnvironment(
  telegramToken: string,
  model: ReturnType<typeof readModelConfig>,
) {
  return {
    TELEGRAM_BOT_TOKEN: telegramToken,
    DEEPSEEK_API_KEY: model.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: model.DEEPSEEK_BASE_URL,
    DEEPSEEK_THINKING_ENABLED: String(model.DEEPSEEK_THINKING_ENABLED),
    DEEPSEEK_REASONING_EFFORT: model.DEEPSEEK_REASONING_EFFORT,
    DEEPSEEK_ROUTING_ENABLED: String(model.DEEPSEEK_ROUTING_ENABLED),
    DEEPSEEK_ROUTING_MODE: model.DEEPSEEK_ROUTING_MODE,
    DEEPSEEK_ROUTER_TIMEOUT_MS: String(model.DEEPSEEK_ROUTER_TIMEOUT_MS),
    ...(model.DEEPSEEK_ROUTER_MIN_CONFIDENCE === undefined
      ? {}
      : {
          DEEPSEEK_ROUTER_MIN_CONFIDENCE: String(
            model.DEEPSEEK_ROUTER_MIN_CONFIDENCE,
          ),
        }),
    DEEPSEEK_INPUT_PRICE_PER_MILLION: String(
      model.DEEPSEEK_INPUT_PRICE_PER_MILLION,
    ),
    DEEPSEEK_OUTPUT_PRICE_PER_MILLION: String(
      model.DEEPSEEK_OUTPUT_PRICE_PER_MILLION,
    ),
    ...(process.env.SKILLS_ENABLED
      ? { SKILLS_ENABLED: process.env.SKILLS_ENABLED }
      : {}),
    ...(process.env.SKILL_MAX_TOOL_STEPS
      ? { SKILL_MAX_TOOL_STEPS: process.env.SKILL_MAX_TOOL_STEPS }
      : {}),
    ...databaseProcessEnv(),
  };
}
