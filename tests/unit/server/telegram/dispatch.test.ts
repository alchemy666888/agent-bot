import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({
  Pool: class {
    query() {
      return Promise.resolve({ rows: [] });
    }
  },
}));

import {
  DEFAULT_SYSTEM_PROMPT,
  readModelConfig,
} from "../../../../src/server/config";
import { readDatabaseConfig } from "../../../../src/shared/postgres/config";
import {
  dispatchTelegramInput,
  installDispatchSkillAuthoringService,
  loadSkillCatalog,
  workerEnvironment,
} from "../../../../src/server/telegram/dispatch";

describe("Telegram dispatch skill catalog", () => {
  it("passes blank optional settings and reaches authoring for the reported request", async () => {
    const prior = { ...process.env };
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2",
      DEEPSEEK_THINKING_ENABLED: "",
      DEEPSEEK_REASONING_EFFORT: "",
      DEEPSEEK_BASE_URL: "",
      ASSISTANT_SYSTEM_PROMPT: "",
      PROMPT_READS_ENABLED: "",
      GITHUB_CONNECTOR: "github/skills-repo",
      GITHUB_SKILLS_OWNER: "alchemy666888",
      GITHUB_SKILLS_REPO: "skill",
      GITHUB_SKILLS_BRANCH: "main",
      GITHUB_SKILLS_PREFIX: "skills",
      DATABASE_URL: "postgres://user:pass@db.test/app",
      SKILL_AUTHOR_TELEGRAM_IDS: "",
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, result: {} }));
    try {
      await expect(
        dispatchTelegramInput({
          kind: "text",
          updateId: "1",
          messageId: "2",
          chatId: "3",
          userId: "4",
          languageCode: "zh-TW",
          text: "你可以生成並安裝AI skill 嗎",
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: { handled: "skill-authoring" },
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain(
        "not authorized",
      );
      expect(String(fetch.mock.calls[0]?.[0])).not.toContain(
        "api.deepseek.com",
      );
    } finally {
      process.env = prior;
    }
  });

  afterEach(() => {
    installDispatchSkillAuthoringService(undefined);
    vi.restoreAllMocks();
  });

  it("tells the user when the GitHub connector is not attached", async () => {
    const prior = { ...process.env };
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2",
      PROMPT_READS_ENABLED: "false",
    });
    installDispatchSkillAuthoringService({
      shouldHandle: async () => true,
      handle: async () => {
        throw new Error("GITHUB_CONNECTOR_NOT_FOUND");
      },
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, result: {} }));
    try {
      await expect(
        dispatchTelegramInput({
          kind: "text",
          updateId: "9",
          messageId: "9",
          chatId: "3",
          userId: "4",
          languageCode: "zh-TW",
          text: "你可以生成並安裝AI skill 嗎",
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: { handled: "skill-authoring" },
      });
      expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain(
        "GitHub connector",
      );
      expect(String(fetch.mock.calls[0]?.[0])).toContain("api.telegram.org");
    } finally {
      process.env = prior;
    }
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
    expect(Object.values(env).some((value) => /[\r\n]/.test(value))).toBe(
      false,
    );
    expect(readDatabaseConfig(env).AIVEN_PG_CA).toBe(certificate);
  });

  it("uses the validated catalog when GitHub is available", async () => {
    const catalog = { commitSha: "a".repeat(40), skills: [] };

    await expect(
      loadSkillCatalog(async () => catalog, "correlation-id"),
    ).resolves.toEqual({ catalog, degradationReason: "catalog_missing" });
  });

  it("continues without skills when GitHub Connect is unavailable", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      loadSkillCatalog(async () => {
        throw new Error("connector response containing private detail");
      }, "correlation-id"),
    ).resolves.toEqual({
      catalog: { commitSha: "0".repeat(40), skills: [] },
      degradationReason: "repository_unavailable",
    });

    expect(log).toHaveBeenCalledOnce();
    const event = JSON.parse(log.mock.calls[0]![0]);
    expect(event).toMatchObject({
      correlationId: "correlation-id",
      operation: "skill.catalog_load",
      result: "degraded",
      code: "GITHUB_CATALOG_UNAVAILABLE",
    });
    expect(log.mock.calls[0]![0]).not.toContain("private detail");
  });

  it("preserves a resolved commit when a pinned catalog read fails", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const commit = "a".repeat(40);

    await expect(
      loadSkillCatalog(
        async () => {
          throw new Error("GitHub returned 404");
        },
        "correlation-id",
        commit,
      ),
    ).resolves.toEqual({
      catalog: { commitSha: commit, skills: [] },
      degradationReason: "repository_unavailable",
    });

    expect(log).toHaveBeenCalledOnce();
  });
});
