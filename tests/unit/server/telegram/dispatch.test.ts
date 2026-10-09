import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/connect", () => ({
  getToken: vi.fn(async () => "github-token"),
}));
vi.mock("../../../../src/server/sandbox/controller", () => ({
  ensureSandbox: vi.fn(async () => ({})),
}));
vi.mock("../../../../src/server/sandbox/transport", () => ({
  installWorker: vi.fn(async () => "worker.mjs"),
  invokeWorker: vi.fn(async () => ({
    ok: true,
    data: { handled: "telegramTurn" },
  })),
}));
const { skillQuery } = vi.hoisted(() => ({
  skillQuery: vi.fn(async () => ({ rows: [] as Record<string, unknown>[] })),
}));
vi.mock("pg", () => ({
  Pool: class {
    query(...args: unknown[]) {
      return skillQuery(...args);
    }
  },
}));

import {
  DEFAULT_SYSTEM_PROMPT,
  readModelConfig,
} from "../../../../src/server/config";
import { readDatabaseConfig } from "../../../../src/shared/postgres/config";
import { invokeWorker } from "../../../../src/server/sandbox/transport";
import { workerRequestSchema } from "../../../../src/shared/contracts/worker";
import { compiledEmergencyBundle } from "../../../../src/worker/prompts/bundle";
import type { GitHubPromptStore } from "../../../../src/server/prompts/github-store";
import { SkillAuthoringService } from "../../../../src/server/skills/service";
import { EMPTY_SKILL_CATALOG_TOKEN } from "../../../../src/worker/skills/schemas";
import { TELEGRAM_ACCESS_DENIED_TEXT } from "../../../../src/server/telegram/access";
import {
  dispatchTelegramInput,
  installDispatchPromptServices,
  loadSkillCatalog,
  workerEnvironment,
} from "../../../../src/server/telegram/dispatch";

describe("Telegram dispatch skill catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries({
      SANDBOX_NAME: "test-sandbox",
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2",
      PROMPT_READS_ENABLED: "false",
      GITHUB_CONNECTOR: "github/skills-repo",
      GITHUB_SKILLS_OWNER: "alchemy666888",
      GITHUB_SKILLS_REPO: "skill",
      GITHUB_SKILLS_BRANCH: "ai/obsolete-draft",
      DATABASE_URL: "postgres://user:pass@db.test/app",
      ALLOW_USERS: "4",
    }))
      vi.stubEnv(key, value);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    skillQuery.mockReset();
    skillQuery.mockResolvedValue({ rows: [] });
  });

  const input = {
    kind: "text" as const,
    updateId: "1",
    messageId: "2",
    chatId: "3",
    userId: "4",
    text: "今天香港天氣怎樣？",
  };

  it("loads published skills from PostgreSQL and does not read GitHub", async () => {
    const shouldHandle = vi
      .spyOn(SkillAuthoringService.prototype, "shouldHandle")
      .mockResolvedValue(true);
    const fetcher = vi.spyOn(globalThis, "fetch");
    const id = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0";
    const versionId = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d9";
    skillQuery.mockResolvedValue({
      rows: [
        {
          skill_name: "weather",
          owner_telegram_user_id: "4",
          visibility: "public",
          skill_status: "active",
          current_version_id: versionId,
          id: versionId,
          skill_id: id,
          revision: 1,
          content_digest: `sha256:${"a".repeat(64)}`,
          manifest: {
            schemaVersion: 1,
            id,
            name: "weather",
            description: "Current weather",
            revision: 1,
            visibility: "public",
            ownerTelegramUserIds: ["4"],
            allowedTelegramUserIds: [],
            triggers: { phrases: ["天氣"], keywords: [], minimumConfidence: 1 },
            tools: ["web_search"],
            prohibitedActions: [],
            status: "active",
          },
          instructions: "Search current weather.",
          state: "published",
          created_by: "4",
        },
      ],
    });
    await dispatchTelegramInput(input);
    expect(shouldHandle).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: null,
      payload: { skillCatalog: { skills: [{ id, versionId }] } },
    });
  });

  it("continues to the worker when PostgreSQL is unavailable", async () => {
    skillQuery.mockRejectedValue(new Error("database unavailable"));
    await expect(dispatchTelegramInput(input)).resolves.toMatchObject({
      ok: true,
    });
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: null,
      payload: {
        skillCatalog: { catalogToken: EMPTY_SKILL_CATALOG_TOKEN, skills: [] },
      },
      degradationNotices: expect.arrayContaining(["repository_unavailable"]),
    });
  });

  it("drops skills requiring unavailable capabilities so the worker can fall back", async () => {
    const id = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0";
    const versionId = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d9";
    skillQuery.mockResolvedValue({
      rows: [
        {
          skill_name: "weather",
          owner_telegram_user_id: "4",
          visibility: "public",
          skill_status: "active",
          current_version_id: versionId,
          id: versionId,
          skill_id: id,
          revision: 1,
          content_digest: `sha256:${"b".repeat(64)}`,
          manifest: {
            schemaVersion: 1,
            id,
            name: "weather",
            visibility: "public",
            ownerTelegramUserIds: ["4"],
            allowedTelegramUserIds: [],
            triggers: { phrases: ["天氣"], keywords: [], minimumConfidence: 1 },
            tools: ["unknown_tool"],
            prohibitedActions: [],
            status: "active",
          },
          instructions: "Use unknown_tool.",
          state: "published",
          created_by: "4",
        },
      ],
    });
    await dispatchTelegramInput(input);
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: null,
      payload: {
        skillCatalog: { catalogToken: EMPTY_SKILL_CATALOG_TOKEN, skills: [] },
      },
    });
  });

  it("continues when enabled repository prompts cannot load", async () => {
    for (const [key, value] of Object.entries({
      PROMPT_READS_ENABLED: "true",
      GITHUB_PROMPTS_OWNER: "alchemy666888",
      GITHUB_PROMPTS_REPO: "skill",
      GITHUB_PROMPTS_BRANCH: "ai/obsolete-prompt",
      GITHUB_PROMPTS_PREFIX: "prompts",
      PROMPT_OPERATOR_TELEGRAM_IDS: "4",
      PROMPT_USER_KEY_SECRET: "fixture-secret-with-at-least-32-characters",
    }))
      vi.stubEnv(key, value);
    const load = vi.fn(async () => {
      throw new Error("prompt missing");
    });
    installDispatchPromptServices({
      resolve: async () => compiledEmergencyBundle("safe base"),
      repository: {
        identity: {
          connector: "github/skills-repo",
          owner: "alchemy666888",
          repository: "skill",
          branch: "main",
        },
        store: { load } as unknown as GitHubPromptStore,
      },
    });
    await dispatchTelegramInput(input);
    expect(load).toHaveBeenCalledWith();
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: null,
      promptBundle: { degradedModeSource: "compiled_emergency" },
    });
  });

  afterEach(() => {
    installDispatchPromptServices(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards normalized worker settings on one line", () => {
    const certificate =
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
    const prior = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: "postgres://user:pass@db.test/app?sslmode=require",
      AIVEN_PG_CA: certificate,
      SKILLS_ENABLED: " false ",
      SKILL_MAX_TOOL_STEPS: " 5 ",
      SKILL_EXECUTION_TIMEOUT_MS: "",
    });
    let env: ReturnType<typeof workerEnvironment>;
    try {
      env = workerEnvironment(
        "telegram-token",
        readModelConfig({
          DEEPSEEK_API_KEY: "key",
          DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
          DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2",
          DEEPSEEK_THINKING_ENABLED: "",
          DEEPSEEK_BASE_URL: "",
          DEEPSEEK_ROUTING_ENABLED: "",
          DEEPSEEK_ROUTING_MODE: "",
          DEEPSEEK_ROUTER_TIMEOUT_MS: "",
          ASSISTANT_SYSTEM_PROMPT: "line one\nline two",
        }),
      );
    } finally {
      process.env = prior;
    }
    expect(env).toMatchObject({
      TELEGRAM_BOT_TOKEN: "telegram-token",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_THINKING_ENABLED: "true",
      DEEPSEEK_ROUTING_ENABLED: "false",
      DEEPSEEK_ROUTING_MODE: "shadow",
      DEEPSEEK_ROUTER_TIMEOUT_MS: "3000",
      ASSISTANT_SYSTEM_PROMPT: "line one line two",
      SKILLS_ENABLED: "false",
      SKILL_MAX_TOOL_STEPS: "5",
    });
    expect(env.ASSISTANT_SYSTEM_PROMPT).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(env).not.toHaveProperty("SKILL_EXECUTION_TIMEOUT_MS");
    expect(env).not.toHaveProperty("ALLOW_USERS");
    expect(Object.values(env).some((value) => /[\r\n]/.test(value))).toBe(
      false,
    );
    expect(readDatabaseConfig(env).AIVEN_PG_CA).toBe(certificate);
  });

  it("uses the validated catalog when PostgreSQL is available", async () => {
    const catalog = { catalogToken: EMPTY_SKILL_CATALOG_TOKEN, skills: [] };

    await expect(
      loadSkillCatalog(async () => catalog, "correlation-id"),
    ).resolves.toEqual({ catalog, degradationReason: "catalog_missing" });
  });

  it("continues without skills when PostgreSQL is unavailable", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      loadSkillCatalog(async () => {
        throw new Error("connector response containing private detail");
      }, "correlation-id"),
    ).resolves.toEqual({
      catalog: { catalogToken: EMPTY_SKILL_CATALOG_TOKEN, skills: [] },
      degradationReason: "repository_unavailable",
    });

    expect(log).toHaveBeenCalledOnce();
    const event = JSON.parse(log.mock.calls[0]![0]);
    expect(event).toMatchObject({
      correlationId: "correlation-id",
      operation: "skill.catalog_load",
      result: "degraded",
      code: "SKILL_CATALOG_UNAVAILABLE",
    });
    expect(log.mock.calls[0]![0]).not.toContain("private detail");
  });

  it("refuses a Telegram account that is not on ALLOW_USERS", async () => {
    vi.stubEnv("ALLOW_USERS", "luckyvickyforever,another_user");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchTelegramInput({ ...input, username: "someoneelse" }),
    ).resolves.toMatchObject({ ok: true });

    expect(invokeWorker).not.toHaveBeenCalled();
    expect(skillQuery).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toEqual({
      chat_id: "3",
      text: TELEGRAM_ACCESS_DENIED_TEXT,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.telegram.org/bottoken/sendMessage",
    );
  });

  it("matches an allowlisted username without @ and ignores case", async () => {
    vi.stubEnv("ALLOW_USERS", "@LuckyVickyForever");
    await dispatchTelegramInput({
      ...input,
      username: "luckyvickyforever",
    });
    expect(invokeWorker).toHaveBeenCalledOnce();
  });

  it("refuses a callback from an account that is not allowlisted", async () => {
    vi.stubEnv("ALLOW_USERS", "luckyvickyforever");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchTelegramInput({
      kind: "callback",
      updateId: "9",
      callbackQueryId: "callback-id",
      messageId: "8",
      chatId: "3",
      userId: "4",
      username: "someoneelse",
      data: "y_abcdefghijklmnopqrstuvwxyz123456",
    });

    expect(invokeWorker).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({
      callback_query_id: "callback-id",
    });
  });
});
