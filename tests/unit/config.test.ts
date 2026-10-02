import { describe, expect, it } from "vitest";

import {
  databaseProcessEnv,
  readDatabaseConfig,
} from "../../src/shared/postgres/config";
import {
  DEFAULT_SYSTEM_PROMPT,
  readDashboardConfig,
  readGitHubConfig,
  readModelConfig,
  readPromptConfig,
  readSandboxConfig,
  readTelegramConfig,
} from "../../src/server/config";

describe("entry-point configuration", () => {
  it("uses approved model defaults", () => {
    const config = readModelConfig({
      DEEPSEEK_API_KEY: "fixture-key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1.25",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2.50",
    });
    expect(config).toMatchObject({
      ASSISTANT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
      DEEPSEEK_THINKING_ENABLED: true,
      DEEPSEEK_REASONING_EFFORT: "medium",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_ROUTING_ENABLED: false,
      DEEPSEEK_ROUTING_MODE: "shadow",
      DEEPSEEK_ROUTER_TIMEOUT_MS: 3_000,
    });
  });

  it.each([
    { DEEPSEEK_ROUTING_ENABLED: "yes" },
    { DEEPSEEK_ROUTING_MODE: "automatic" },
    { DEEPSEEK_ROUTER_TIMEOUT_MS: "249" },
    { DEEPSEEK_ROUTER_TIMEOUT_MS: "30001" },
    { DEEPSEEK_ROUTER_MIN_CONFIDENCE: "-0.1" },
    { DEEPSEEK_ROUTER_MIN_CONFIDENCE: "1.1" },
  ])("rejects invalid router configuration %#", (invalid) => {
    expect(() =>
      readModelConfig({
        DEEPSEEK_API_KEY: "fixture-key",
        DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "1",
        ...invalid,
      }),
    ).toThrow();
  });

  it.each([
    {},
    { TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "ok" },
    { TELEGRAM_BOT_TOKEN: "ok", TELEGRAM_WEBHOOK_SECRET: "" },
  ])("rejects missing or empty Telegram settings", (env) => {
    expect(() => readTelegramConfig(env)).toThrow();
  });

  it.each(["TRUE", "yes", "1", ""])('rejects invalid boolean "%s"', (value) => {
    expect(() =>
      readModelConfig({
        DEEPSEEK_API_KEY: "fixture-key",
        DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "1",
        DEEPSEEK_THINKING_ENABLED: value,
      }),
    ).toThrow();
  });

  it.each(["-1", "NaN", "free", ""])("rejects invalid price %s", (value) => {
    expect(() =>
      readModelConfig({
        DEEPSEEK_API_KEY: "fixture-key",
        DEEPSEEK_INPUT_PRICE_PER_MILLION: value,
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "1",
      }),
    ).toThrow();
  });

  it("rejects a region other than sin1", () => {
    expect(() =>
      readSandboxConfig({
        SANDBOX_NAME: "fixture-sandbox",
        SANDBOX_REGION: "iad1",
      }),
    ).toThrow();
  });

  it("loads validated server-only GitHub connector settings", () => {
    expect(
      readGitHubConfig({
        GITHUB_CONNECTOR: "github/skills-repo",
        GITHUB_SKILLS_OWNER: "alchemy666888",
        GITHUB_SKILLS_REPO: "skill",
        GITHUB_SKILLS_BRANCH: "feature/skills-v2",
        GITHUB_SKILLS_PREFIX: "skills/approved",
        NEXT_PUBLIC_GITHUB_TOKEN: "must-not-be-returned",
        VERCEL_OIDC_TOKEN: "must-not-be-returned",
      }),
    ).toEqual({
      GITHUB_CONNECTOR: "github/skills-repo",
      GITHUB_SKILLS_OWNER: "alchemy666888",
      GITHUB_SKILLS_REPO: "skill",
      GITHUB_SKILLS_BRANCH: "feature/skills-v2",
      GITHUB_SKILLS_PREFIX: "skills/approved",
    });
  });

  it.each([
    { GITHUB_CONNECTOR: "gitlab/skills-repo" },
    { GITHUB_SKILLS_OWNER: "bad owner" },
    { GITHUB_SKILLS_REPO: "../skill" },
    { GITHUB_SKILLS_BRANCH: "main..other" },
    { GITHUB_SKILLS_PREFIX: "/skills" },
    { GITHUB_SKILLS_PREFIX: "skills/../private" },
  ])("rejects invalid GitHub settings %#", (invalid) => {
    expect(() =>
      readGitHubConfig({
        GITHUB_CONNECTOR: "github/skills-repo",
        GITHUB_SKILLS_OWNER: "alchemy666888",
        GITHUB_SKILLS_REPO: "skill",
        GITHUB_SKILLS_BRANCH: "main",
        GITHUB_SKILLS_PREFIX: "skills",
        ...invalid,
      }),
    ).toThrow();
  });

  it("loads each entry point independently", () => {
    expect(
      readTelegramConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_WEBHOOK_SECRET: "secret",
      }),
    ).toBeTruthy();
    expect(
      readDashboardConfig({
        DASHBOARD_SECRET: "any non-empty value",
        SESSION_SIGNING_SECRET: "fixture-signing-secret",
        APP_URL: "https://example.test",
      }),
    ).toBeTruthy();
    expect(
      readSandboxConfig({
        SANDBOX_NAME: "sandbox",
      }).region,
    ).toBe("sin1");
    expect(
      readDatabaseConfig({ DATABASE_URL: "postgresql://user:pass@db.test/app" })
        .DATABASE_URL,
    ).toBe("postgresql://user:pass@db.test/app");
  });

  describe("prompt hierarchy configuration", () => {
    const enabled = {
      PROMPT_HIERARCHY_ENABLED: "true",
      GITHUB_CONNECTOR: "github/skills-repo",
      GITHUB_PROMPTS_OWNER: "alchemy666888",
      GITHUB_PROMPTS_REPO: "skill",
      GITHUB_PROMPTS_BRANCH: "feature/read-only-preview",
      GITHUB_PROMPTS_PREFIX: "prompts/approved",
      PROMPT_OPERATOR_TELEGRAM_IDS: "123456789,987654321",
      PROMPT_USER_KEY_SECRET: "fixture-secret-with-at-least-32-characters",
    };

    it("defaults to disabled without requiring or contacting a repository", () => {
      expect(readPromptConfig({})).toEqual({
        PROMPT_HIERARCHY_ENABLED: false,
        PROMPT_HIERARCHY_WRITES_ENABLED: false,
        PROMPT_CACHE_TTL_SECONDS: 300,
        PROMPT_CONFIRMATION_TTL_SECONDS: 600,
        PROMPT_ROUTER_CONFIDENCE_THRESHOLD: 0.75,
        PROMPT_ROUTER_ENABLED: false,
      });
    });

    it("loads enabled server-only settings and preserves operator IDs as strings", () => {
      const config = readPromptConfig({
        ...enabled,
        NEXT_PUBLIC_PROMPT_USER_KEY_SECRET: "must-not-be-returned",
      });

      expect(config.GITHUB_PROMPTS_PREFIX).toBe("prompts/approved");
      expect(config.PROMPT_OPERATOR_TELEGRAM_IDS).toEqual(
        new Set(["123456789", "987654321"]),
      );
      expect(config).not.toHaveProperty("NEXT_PUBLIC_PROMPT_USER_KEY_SECRET");
    });

    it.each([
      "",
      "123,",
      ",123",
      "123,,456",
      "123,123",
      "+123",
      "-123",
      "0123",
      "123, 456",
      "9007199254740992",
    ])("rejects malformed operator IDs %j", (ids) => {
      expect(() =>
        readPromptConfig({
          ...enabled,
          PROMPT_OPERATOR_TELEGRAM_IDS: ids,
        }),
      ).toThrow();
    });

    it.each([
      "prompts/",
      "/prompts",
      "prompts//team",
      "prompts/../team",
      " prompts",
    ])("rejects non-normalized prompt prefix %j", (prefix) => {
      expect(() =>
        readPromptConfig({ ...enabled, GITHUB_PROMPTS_PREFIX: prefix }),
      ).toThrow();
    });

    it.each([
      { PROMPT_CACHE_TTL_SECONDS: "0" },
      { PROMPT_CACHE_TTL_SECONDS: "86401" },
      { PROMPT_CONFIRMATION_TTL_SECONDS: "29" },
      { PROMPT_CONFIRMATION_TTL_SECONDS: "3601" },
      { PROMPT_ROUTER_CONFIDENCE_THRESHOLD: "-0.01" },
      { PROMPT_ROUTER_CONFIDENCE_THRESHOLD: "1.01" },
      { PROMPT_USER_KEY_SECRET: "weak" },
      { PROMPT_USER_KEY_SECRET: "a".repeat(64) },
    ])("rejects unsafe prompt setting %#", (invalid) => {
      expect(() => readPromptConfig({ ...enabled, ...invalid })).toThrow();
    });

    it("requires every security-critical setting when enabled", () => {
      for (const key of Object.keys(enabled)) {
        if (key === "PROMPT_HIERARCHY_ENABLED") continue;
        expect(() =>
          readPromptConfig({ ...enabled, [key]: undefined }),
        ).toThrow();
      }
    });

    it("allows non-main read-only branches but requires main for writes", () => {
      expect(readPromptConfig(enabled).GITHUB_PROMPTS_BRANCH).toBe(
        "feature/read-only-preview",
      );
      expect(() =>
        readPromptConfig({
          ...enabled,
          PROMPT_HIERARCHY_WRITES_ENABLED: "true",
        }),
      ).toThrow();
      expect(
        readPromptConfig({
          ...enabled,
          PROMPT_HIERARCHY_WRITES_ENABLED: "true",
          GITHUB_PROMPTS_BRANCH: "main",
        }).PROMPT_HIERARCHY_WRITES_ENABLED,
      ).toBe(true);
    });
  });

  it("requires and passes the PostgreSQL connection string", () => {
    expect(() => databaseProcessEnv({})).toThrow();
    expect(
      databaseProcessEnv({ DATABASE_URL: "postgres://u:p@db.test/app" }),
    ).toEqual({ DATABASE_URL: "postgres://u:p@db.test/app" });
  });

  it("passes a multiline Aiven CA certificate to the worker", () => {
    const certificate =
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
    expect(
      databaseProcessEnv({
        DATABASE_URL: "postgres://u:p@db.test/app?sslmode=require",
        AIVEN_PG_CA: certificate,
      }),
    ).toEqual({
      DATABASE_URL: "postgres://u:p@db.test/app?sslmode=verify-full",
      AIVEN_PG_CA: certificate,
    });
  });

  it.each(["prefer", "require", "verify-ca"])(
    "makes the legacy %s SSL mode explicitly strict",
    (sslmode) => {
      expect(
        readDatabaseConfig({
          DATABASE_URL: `postgres://u:p@db.test/app?sslmode=${sslmode}`,
        }).DATABASE_URL,
      ).toBe("postgres://u:p@db.test/app?sslmode=verify-full");
    },
  );

  it("preserves explicit libpq-compatible SSL configuration", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL:
          "postgres://u:p@db.test/app?uselibpqcompat=true&sslmode=require",
      }).DATABASE_URL,
    ).toBe("postgres://u:p@db.test/app?uselibpqcompat=true&sslmode=require");
  });

  it("rejects a non-PostgreSQL database URL", () => {
    expect(() =>
      readDatabaseConfig({ DATABASE_URL: "https://db.test" }),
    ).toThrow();
  });
});
