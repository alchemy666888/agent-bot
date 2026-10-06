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
import { createCapabilityRegistry } from "../../worker/capabilities";
import { PromptMetadataRouter } from "../../worker/prompts/router";
import {
  MAX_AUTHORIZED_SKILL_CATALOG_BYTES,
  MAX_AUTHORIZED_SKILL_COUNT,
} from "../../shared/contracts";
import type { DegradationNotice } from "../../shared/contracts/worker";

const MAX_SKILL_CATALOG_BYTES = MAX_AUTHORIZED_SKILL_CATALOG_BYTES;
// The catalog crosses the worker boundary and is then serialized once more as
// trusted model context, so budget both representations plus the prompt.
export const MAX_WORKER_CONTEXT_BYTES = MAX_SKILL_CATALOG_BYTES * 2;

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");

type SkillCatalog = Awaited<
  ReturnType<GitHubSkillRepository["loadCatalogSnapshot"]>
>;

export function promptDegradationNotices(
  promptBundle: Awaited<ReturnType<DispatchPromptServices["resolve"]>>,
  requestText: string,
): DegradationNotice[] {
  const notices: DegradationNotice[] = [];
  if (
    promptBundle.telemetry.degraded &&
    promptBundle.degradedModeSource === "verified_snapshot"
  )
    notices.push("stale_snapshot");
  if (
    promptBundle.telemetry.degraded &&
    (promptBundle.degradedModeSource === "compiled_emergency" ||
      promptBundle.commonSystemPrompt.source === "compiled_emergency")
  )
    notices.push("system_prompt_missing", "compiled_emergency_prompt");
  // A default request prompt is normal. It is degraded only when the user
  // actually attempted to select a request prompt and selection fell back.
  if (
    promptBundle.resolutionSource === "default" &&
    promptBundle.telemetry.resolution === "fallback" &&
    /^\/prompt(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/i.test(requestText)
  )
    notices.push("request_prompt_missing");
  return notices;
}

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
    pinnedSnapshot?: import("../prompts/github-store").VerifiedPromptSnapshot;
  }): ReturnType<PromptService["resolve"]>;
  confirmation?: Pick<PromptConfirmationService, "respond">;
  repository?: {
    store: GitHubPromptStore;
    identity: {
      connector: string;
      owner: string;
      repository: string;
      branch: string;
    };
  };
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
  if (!config.PROMPT_READS_ENABLED)
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
    branch: "main",
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
      personalReadsEnabled: config.PROMPT_PERSONAL_READS_ENABLED,
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
    repository: {
      store,
      identity: {
        connector: config.GITHUB_CONNECTOR as string,
        owner: identity.owner,
        repository: identity.name,
        branch: identity.branch,
      },
    },
  };
  return repositoryPromptServices;
}

/**
 * Skills are an optional enhancement to an ordinary Telegram conversation.
 * Fail closed (with no skills) when GitHub Connect is unavailable so a
 * connector outage cannot prevent the bot from answering normal messages.
 */
export async function loadSkillCatalog(
  load: () => Promise<SkillCatalog>,
  correlationId: string,
  /** Preserve an already-resolved repository pin when degrading mid-turn. */
  pinnedCommitSha: string | (() => string) = EMPTY_SKILL_CATALOG.commitSha,
): Promise<{
  catalog: SkillCatalog;
  degradationReason?: "repository_unavailable" | "catalog_missing";
}> {
  const started = Date.now();
  try {
    const catalog = await load();
    return {
      catalog,
      ...(catalog.skills.length === 0
        ? { degradationReason: "catalog_missing" as const }
        : {}),
    };
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
    return {
      catalog: {
        ...EMPTY_SKILL_CATALOG,
        commitSha:
          typeof pinnedCommitSha === "function"
            ? pinnedCommitSha()
            : pinnedCommitSha,
      },
      degradationReason: "repository_unavailable",
    };
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
  const promptConfig = readPromptConfig({
    ...process.env,
    GITHUB_PROMPTS_BRANCH: "main",
  });
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
  let services: DispatchPromptServices;
  try {
    services = promptServices ?? configuredPromptService(promptConfig, model);
  } catch (error) {
    const failure = safeError(error, "PROMPT_REPOSITORY_UNAVAILABLE", "prompt");
    logStructured({
      correlationId,
      component: "controller",
      operation: "prompt.resolve",
      stage: "prompt-repository",
      result: "degraded",
      code: failure.code,
    });
    services = emergencyPromptService(model.ASSISTANT_SYSTEM_PROMPT);
  }
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

  // Telegram conversations only consume published skills. Stored authoring
  // drafts never intercept messages or introduce a draft branch into a turn.
  let resolvedCommit = EMPTY_SKILL_CATALOG.commitSha;
  const catalogResult = await loadSkillCatalog(
    async () => {
      const github = readGitHubConfig({
        ...process.env,
        GITHUB_SKILLS_BRANCH: "main",
      });
      const client = createGitHubSkillsClient(
        {
          connector: github.GITHUB_CONNECTOR,
          owner: github.GITHUB_SKILLS_OWNER,
          repository: github.GITHUB_SKILLS_REPO,
          branch: "main",
          prefix: github.GITHUB_SKILLS_PREFIX,
        },
        { audit: (event) => auditGitHubEvent(correlationId, event) },
      );
      // Resolve the remote head for every turn; never reuse a symbolic-ref cache.
      const head = await client.getBranchHead("main");
      if (!/^[0-9a-f]{40}$/.test(head))
        throw new Error("INVALID_REPOSITORY_COMMIT");
      resolvedCommit = head;
      const catalog = await new GitHubSkillRepository(client, {
        audit: (event) => auditGitHubEvent(correlationId, event),
      }).loadCatalogSnapshot({ telegramUserId: input.userId }, resolvedCommit);
      const capabilities = createCapabilityRegistry();
      return {
        ...catalog,
        skills: catalog.skills.filter((skill) => {
          try {
            capabilities.requests(skill.tools);
            return true;
          } catch {
            logStructured({
              correlationId,
              component: "controller",
              operation: "skill.catalog_load",
              stage: "skill-repository",
              result: "degraded",
              code: "SKILL_CAPABILITY_UNAVAILABLE",
            });
            return false;
          }
        }),
      };
    },
    correlationId,
    () => resolvedCommit,
  );
  const skillCatalogDegradation = catalogResult.degradationReason;
  const repositoryCommitSha =
    resolvedCommit === EMPTY_SKILL_CATALOG.commitSha ? null : resolvedCommit;
  const promptInput = {
    userKey: promptConfig.PROMPT_USER_KEY_SECRET
      ? derivePromptUserKey(
          promptConfig.PROMPT_USER_KEY_SECRET as string,
          input.userId,
        )
      : "u1_" + "A".repeat(43),
    text: input.text,
    correlationId,
    ...(input.languageCode ? { language: input.languageCode } : {}),
  };
  let promptBundle: Awaited<ReturnType<DispatchPromptServices["resolve"]>>;
  try {
    if (promptConfig.PROMPT_READS_ENABLED && services.repository) {
      const github = readGitHubConfig({
        ...process.env,
        GITHUB_SKILLS_BRANCH: "main",
      });
      const identity = services.repository.identity;
      if (
        !repositoryCommitSha ||
        identity.branch !== "main" ||
        identity.connector !== github.GITHUB_CONNECTOR ||
        identity.owner !== github.GITHUB_SKILLS_OWNER ||
        identity.repository !== github.GITHUB_SKILLS_REPO
      )
        throw new Error("REPOSITORY_IDENTITY_MISMATCH");
      const pinnedSnapshot =
        await services.repository.store.load(repositoryCommitSha);
      if (pinnedSnapshot.commitSha !== repositoryCommitSha)
        throw new Error("REPOSITORY_COMMIT_MISMATCH");
      promptBundle = await services.resolve({ ...promptInput, pinnedSnapshot });
    } else {
      promptBundle = await services.resolve(promptInput);
    }
    if (
      promptBundle.repositoryCommitSha !== null &&
      promptBundle.repositoryCommitSha !== repositoryCommitSha
    )
      throw new Error("REPOSITORY_COMMIT_MISMATCH");
  } catch (error) {
    const failure = safeError(error, "PROMPT_REPOSITORY_UNAVAILABLE", "prompt");
    logStructured({
      correlationId,
      component: "controller",
      operation: "prompt.resolve",
      stage: "prompt-repository",
      result: "degraded",
      code: failure.code,
    });
    promptBundle = await emergencyPromptService(
      model.ASSISTANT_SYSTEM_PROMPT,
    ).resolve(promptInput);
  }
  // Compiled prompts can accompany skills pinned to main without fetching any
  // prompt files. Keep the worker's single-commit contract intact in that case.
  promptBundle = {
    ...promptBundle,
    repositoryCommitSha,
    turnPin: { ...promptBundle.turnPin, commitSha: repositoryCommitSha },
  };
  let skillCatalog: SkillCatalog = catalogResult.catalog;
  const degradationNotices = promptDegradationNotices(promptBundle, input.text);
  if (skillCatalogDegradation) degradationNotices.push(skillCatalogDegradation);
  else if (skillCatalog.skills.length === 0)
    degradationNotices.push("catalog_missing");
  const promptBytes = Buffer.byteLength(JSON.stringify(promptBundle), "utf8");
  let skillBytes = Buffer.byteLength(JSON.stringify(skillCatalog), "utf8");
  if (
    skillCatalog.skills.length > MAX_AUTHORIZED_SKILL_COUNT ||
    skillBytes > MAX_SKILL_CATALOG_BYTES ||
    promptBytes + skillBytes * 2 > MAX_WORKER_CONTEXT_BYTES
  ) {
    // Preserve main's pin while dropping an unusable catalog in its entirety.
    // Never truncate a snapshot or allow its size to block web-search fallback.
    skillCatalog = { ...EMPTY_SKILL_CATALOG, commitSha: resolvedCommit };
    if (!degradationNotices.includes("catalog_too_large"))
      degradationNotices.push("catalog_too_large");
    skillBytes = Buffer.byteLength(JSON.stringify(skillCatalog), "utf8");
  }
  if (promptBytes + skillBytes * 2 > MAX_WORKER_CONTEXT_BYTES)
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
      repositoryCommitSha,
      degradationNotices: [...new Set(degradationNotices)],
      rawTelegramInput: input.text,
    },
    workerEnvironment(telegram.TELEGRAM_BOT_TOKEN, model),
  );
}

function optionalWorkerInteger(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw Object.assign(new Error("WORKER_CONFIGURATION_INVALID"), {
      code: name,
    });
  return String(parsed);
}

/** Values the sandbox command actually receives. Every value is one line. */
export function workerEnvironment(
  telegramToken: string,
  model: ReturnType<typeof readModelConfig>,
) {
  const skillsEnabled = process.env.SKILLS_ENABLED?.trim();
  const skillSteps = optionalWorkerInteger("SKILL_MAX_TOOL_STEPS");
  const skillTimeout = optionalWorkerInteger("SKILL_EXECUTION_TIMEOUT_MS");
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
    // v1 turns (media, edits, non-private chats) build the emergency bundle
    // from this value. Leaving it out fails the worker before any reply.
    ASSISTANT_SYSTEM_PROMPT: model.ASSISTANT_SYSTEM_PROMPT.replace(
      /\s+/g,
      " ",
    ).trim(),
    ...(skillsEnabled === "true" || skillsEnabled === "false"
      ? { SKILLS_ENABLED: skillsEnabled }
      : {}),
    ...(skillSteps ? { SKILL_MAX_TOOL_STEPS: skillSteps } : {}),
    ...(skillTimeout ? { SKILL_EXECUTION_TIMEOUT_MS: skillTimeout } : {}),
    ...databaseProcessEnv(),
  };
}
