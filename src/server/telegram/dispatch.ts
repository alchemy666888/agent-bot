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
  readRepositoryIdentityConfig,
} from "../config";
import { ensureSandbox } from "../sandbox/controller";
import { installWorker, invokeWorker } from "../sandbox/transport";
import { databaseProcessEnv } from "../../shared/postgres/config";
import { uuidV7 } from "../../shared/ids";
import type { TelegramInput } from "./input";
import { createGitHubSkillsClient } from "../github/skills-client";
import {
  GitHubSkillRepository,
  GitHubSkillAuthoringAdapter,
} from "../github/skill-repository";
import { logStructured, safeError } from "../../shared/logger";
import type { GitHubClientEvent } from "../github/skills-client";
import type { SkillRepositoryEvent } from "../github/skill-repository";
import { TelegramClient } from "../../worker/telegram/client";
import { derivePromptUserKey } from "../prompts/identity";
import { resolveRepositoryTurnContext } from "./turn-context";
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
import { SkillAuthoringService } from "../skills/service";
import type { SkillAuthoringRepository } from "../skills/service";
import type { SkillDraftGenerator } from "../../worker/skills/types";
import { PostgresSkillAuthoringRepository } from "../skills/repository";
import { DeepSeekProvider } from "../../worker/model/deepseek";
import { parseTelegramAllowlist } from "../../shared/telegram-allowlist";
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

type DispatchSkillAuthoringService = Pick<
  SkillAuthoringService,
  "shouldHandle" | "handle"
>;
let skillAuthoringService: DispatchSkillAuthoringService | undefined;
let repositorySkillAuthoringService: DispatchSkillAuthoringService | undefined;

/** Installs the trusted authoring coordinator; primarily used by integration wiring. */
export function installDispatchSkillAuthoringService(
  service?: DispatchSkillAuthoringService,
) {
  skillAuthoringService = service;
}

function configuredSkillAuthoringService(
  model: ReturnType<typeof readModelConfig>,
  github: ReturnType<typeof readGitHubConfig>,
): DispatchSkillAuthoringService {
  if (repositorySkillAuthoringService) return repositorySkillAuthoringService;
  const database = readDatabaseConfig();
  const pool = new Pool(
    postgresPoolConfig(database.DATABASE_URL, database.AIVEN_PG_CA),
  );
  const client = new GitHubSkillAuthoringAdapter({
    connector: github.GITHUB_CONNECTOR,
    owner: github.GITHUB_SKILLS_OWNER,
    repository: github.GITHUB_SKILLS_REPO,
    branch: github.GITHUB_SKILLS_BRANCH,
    prefix: github.GITHUB_SKILLS_PREFIX,
  });
  const authors = parseTelegramAllowlist(process.env.SKILL_AUTHOR_TELEGRAM_IDS);
  const capabilities = new Set(
    (process.env.SKILL_AUTHOR_CAPABILITY_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const repository: SkillAuthoringRepository =
    new PostgresSkillAuthoringRepository(pool, client, {
      authorTelegramUserIds: authors.ids,
      authorTelegramUsernames: authors.usernames,
      capabilityIds: capabilities,
    });
  const provider = new DeepSeekProvider({
    apiKey: model.DEEPSEEK_API_KEY,
    baseUrl: model.DEEPSEEK_BASE_URL,
    thinking: model.DEEPSEEK_THINKING_ENABLED,
    maxToolCalls: 0,
  });
  const generator: SkillDraftGenerator = {
    async generateSkillDraft(draft, feedback) {
      const result = await provider.generate({
        executionMode: "direct",
        trustedInstructions: [
          {
            source: "runtime",
            content:
              "Write a concise SKILL.md. Return only markdown, with no code fence. The YAML frontmatter name must be exactly the supplied name, and description must be one line. Preserve all MUST, MUST NOT, and tool constraints.",
          },
        ],
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              name: draft.skillName,
              domain: draft.intendedTasksDomain,
              mustDo: draft.mustDo,
              mustNotDo: draft.mustNotDo,
              betterToDo: draft.betterToDo,
              tools: draft.requiredToolsFunctions,
              feedback,
            }),
          },
        ],
      });
      return result.content;
    },
  };
  return (repositorySkillAuthoringService = new SkillAuthoringService(
    repository,
    generator,
  ));
}

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
      catalog: EMPTY_SKILL_CATALOG,
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

  // Authoring is classified and executed entirely inside the trusted server boundary.
  // Neither connector credentials nor repository authority are included in worker input.
  const authoring =
    skillAuthoringService ??
    configuredSkillAuthoringService(model, readGitHubConfig());
  if (await authoring.shouldHandle(input.userId, input.text)) {
    let response: string;
    try {
      response = await authoring.handle(
        input.userId,
        input.text,
        input.updateId,
        input.languageCode,
        input.username,
      );
    } catch (error) {
      const code = (error as Error).message;
      if (
        code !== "SKILL_AUTHOR_NOT_AUTHORIZED" &&
        code !== "GITHUB_CONNECTOR_NOT_FOUND" &&
        code !== "GITHUB_CONNECTOR_NOT_INSTALLED"
      )
        throw error;

      // These are permanent project/policy results. Acknowledge them so
      // Telegram does not retry the same update.
      logStructured({
        correlationId,
        component: "controller",
        operation: "skill.authoring",
        stage:
          code === "SKILL_AUTHOR_NOT_AUTHORIZED"
            ? "authorization"
            : "skill-repository",
        result: "failure",
        code,
      });
      const chinese = input.languageCode?.toLowerCase().startsWith("zh");
      response =
        code === "SKILL_AUTHOR_NOT_AUTHORIZED"
          ? "You are not authorized to create or publish skills. Ask the bot operator to allow your Telegram user ID."
          : chinese
            ? "還不能建立 skill，因為這個 Vercel 專案沒有連結 GitHub connector。請先建立並 attach connector，然後再傳一次。"
            : "I can't create a skill yet because this Vercel project is not linked to a GitHub connector. Create and attach the connector, then try again.";
    }
    await client.send(input.chatId, response);
    return {
      contractVersion: 1 as const,
      correlationId,
      ok: true as const,
      data: { handled: "skill-authoring" as const },
    };
  }

  const github = readGitHubConfig();
  const turnContext = await (async () => {
    if (!(promptConfig.PROMPT_READS_ENABLED && services.repository)) {
      return {
        promptBundle: await services.resolve({
          userKey: "u1_" + "A".repeat(43),
          text: input.text,
          correlationId,
          ...(input.languageCode ? { language: input.languageCode } : {}),
        }),
        skillCatalog: EMPTY_SKILL_CATALOG,
        repositoryCommitSha: null,
      };
    }

    const identity = readRepositoryIdentityConfig();
    const skillRepository = new GitHubSkillRepository(
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
    );
    return resolveRepositoryTurnContext({
      telegramUserId: input.userId,
      promptUserKeySecret: promptConfig.PROMPT_USER_KEY_SECRET as string,
      text: input.text,
      ...(input.languageCode ? { language: input.languageCode } : {}),
      correlationId,
      identity,
      promptIdentity: services.repository.identity,
      skillIdentity: identity,
      resolveHead: () => services.repository!.store.resolveHead(),
      loadPromptSnapshot: (commit) => services.repository!.store.load(commit),
      resolvePrompt: (request) => services.resolve(request),
      loadSkillCatalog: (telegramUserId, commit) =>
        skillRepository.loadCatalogSnapshot({ telegramUserId }, commit),
    });
  })();
  const { promptBundle, repositoryCommitSha } = turnContext;
  let skillCatalog: SkillCatalog = turnContext.skillCatalog;
  const degradationNotices = promptDegradationNotices(promptBundle, input.text);
  if (skillCatalog.skills.length === 0)
    degradationNotices.push("catalog_missing");
  const promptBytes = Buffer.byteLength(JSON.stringify(promptBundle), "utf8");
  let skillBytes = Buffer.byteLength(JSON.stringify(skillCatalog), "utf8");
  if (
    skillCatalog.skills.length > MAX_AUTHORIZED_SKILL_COUNT ||
    skillBytes > MAX_SKILL_CATALOG_BYTES ||
    promptBytes + skillBytes * 2 > MAX_WORKER_CONTEXT_BYTES
  ) {
    if (repositoryCommitSha !== null)
      throw new Error("WORKER_CONTEXT_TOO_LARGE");
    // The documented safe default is an empty, zero-commit catalog. Never
    // truncate a snapshot: that would make the advertised catalog incomplete.
    skillCatalog = EMPTY_SKILL_CATALOG;
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
