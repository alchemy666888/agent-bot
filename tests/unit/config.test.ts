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
  readRepositoryIdentityConfig,
  readSandboxConfig,
  readTelegramConfig,
} from "../../src/server/config";
import { PROMPT_FILE_MAX_BYTES } from "../../src/shared/contracts/prompt";
import { compiledEmergencyBundle } from "../../src/worker/prompts/bundle";

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
    expect(DEFAULT_SYSTEM_PROMPT.startsWith("# Role\n")).toBe(true);
    expect(
      new TextEncoder().encode(DEFAULT_SYSTEM_PROMPT).byteLength,
    ).toBeLessThanOrEqual(PROMPT_FILE_MAX_BYTES);
    expect(
      compiledEmergencyBundle(DEFAULT_SYSTEM_PROMPT).commonSystemPrompt.content,
    ).toBe(DEFAULT_SYSTEM_PROMPT);
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

  it("parses ALLOW_USERS usernames and numeric ids", () => {
    expect(
      readTelegramConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_WEBHOOK_SECRET: "secret",
        ALLOW_USERS: " @LuckyVickyForever , 123456789 ",
      }).ALLOW_USERS,
    ).toEqual({
      ids: new Set(["123456789"]),
      usernames: new Set(["luckyvickyforever"]),
    });
  });

  it("accepts Allow_USERS as the same whitelist", () => {
    expect(
      readTelegramConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_WEBHOOK_SECRET: "secret",
        Allow_USERS: "luckyvickyforever,another_user",
      }).ALLOW_USERS.usernames,
    ).toEqual(new Set(["luckyvickyforever", "another_user"]));
  });

  it.each(["not a user", "luckyvickyforever,luckyvickyforever", "ab"])(
    "rejects malformed ALLOW_USERS %j",
    (allowUsers) => {
      expect(() =>
        readTelegramConfig({
          TELEGRAM_BOT_TOKEN: "token",
          TELEGRAM_WEBHOOK_SECRET: "secret",
          ALLOW_USERS: allowUsers,
        }),
      ).toThrow();
    },
  );

  it("treats blank optional settings as documented defaults", () => {
    expect(
      readModelConfig({
        DEEPSEEK_API_KEY: "fixture-key",
        DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "1",
        ASSISTANT_SYSTEM_PROMPT: "",
        DEEPSEEK_THINKING_ENABLED: "",
        DEEPSEEK_REASONING_EFFORT: "",
        DEEPSEEK_BASE_URL: "  ",
        DEEPSEEK_ROUTING_ENABLED: "",
        DEEPSEEK_ROUTING_MODE: "",
        DEEPSEEK_ROUTER_TIMEOUT_MS: "",
      }),
    ).toMatchObject({
      ASSISTANT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
      DEEPSEEK_THINKING_ENABLED: true,
      DEEPSEEK_REASONING_EFFORT: "medium",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_ROUTING_ENABLED: false,
      DEEPSEEK_ROUTING_MODE: "shadow",
      DEEPSEEK_ROUTER_TIMEOUT_MS: 3_000,
    });
    expect(
      readSandboxConfig({
        SANDBOX_NAME: "fixture-sandbox",
        SANDBOX_REGION: "",
        VERCEL_OIDC_TOKEN: "",
      }),
    ).toEqual({ SANDBOX_NAME: "fixture-sandbox", region: "sin1" });
    expect(
      readPromptConfig({
        PROMPT_READS_ENABLED: "",
        PROMPT_ROUTER_ENABLED: "",
      }),
    ).toMatchObject({
      PROMPT_READS_ENABLED: false,
      PROMPT_ROUTER_ENABLED: false,
    });
  });

  it.each(["TRUE", "yes", "1"])('rejects invalid boolean "%s"', (value) => {
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

  it("exposes one repository identity and rejects split prompt configuration", () => {
    const env = {
      GITHUB_CONNECTOR: "github/shared-repo",
      GITHUB_SKILLS_OWNER: "owner",
      GITHUB_SKILLS_REPO: "repository",
      GITHUB_SKILLS_BRANCH: "main",
      PROMPT_READS_ENABLED: "true",
      GITHUB_PROMPTS_OWNER: "owner",
      GITHUB_PROMPTS_REPO: "repository",
      GITHUB_PROMPTS_BRANCH: "main",
      GITHUB_PROMPTS_PREFIX: "prompts",
      PROMPT_OPERATOR_TELEGRAM_IDS: "123",
      PROMPT_USER_KEY_SECRET: "0123456789abcdefghijklmnopqrstuvwxyz",
    };
    expect(readRepositoryIdentityConfig(env)).toEqual({
      connector: "github/shared-repo",
      owner: "owner",
      repository: "repository",
      branch: "main",
    });
    expect(() =>
      readRepositoryIdentityConfig({
        ...env,
        GITHUB_PROMPTS_REPO: "another-repository",
      }),
    ).toThrow("Prompt and skill repository identities must match");
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
      }).ALLOW_USERS,
    ).toEqual({ ids: new Set(), usernames: new Set() });
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
      PROMPT_READS_ENABLED: "true",
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
        PROMPT_READS_ENABLED: false,
        PROMPT_PERSONAL_READS_ENABLED: false,
        PROMPT_OPERATOR_WRITES_ENABLED: false,
        PROMPT_PERSONAL_WRITES_ENABLED: false,
        PROMPT_AUTONOMOUS_SUGGESTIONS_ENABLED: false,
        PROMPT_SUGGESTION_COHORT_PERCENT: 0,
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

    it("accepts a Telegram username alongside numeric operator IDs", () => {
      expect(
        readPromptConfig({
          PROMPT_OPERATOR_TELEGRAM_IDS: "@LuckyVickyForever,123456789",
        }).PROMPT_OPERATOR_TELEGRAM_IDS,
      ).toEqual(new Set(["luckyvickyforever", "123456789"]));
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
        if (key === "PROMPT_READS_ENABLED") continue;
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
          PROMPT_OPERATOR_WRITES_ENABLED: "true",
        }),
      ).toThrow();
      expect(
        readPromptConfig({
          ...enabled,
          PROMPT_OPERATOR_WRITES_ENABLED: "true",
          GITHUB_PROMPTS_BRANCH: "main",
        }).PROMPT_OPERATOR_WRITES_ENABLED,
      ).toBe(true);
    });
  });

  it("requires and passes the PostgreSQL connection string", () => {
    expect(() => databaseProcessEnv({})).toThrow();
    expect(
      databaseProcessEnv({ DATABASE_URL: "postgres://u:p@db.test/app" }),
    ).toEqual({ DATABASE_URL: "postgres://u:p@db.test/app" });
  });

  it("passes a single-line Aiven CA that the worker can restore", () => {
    const certificate =
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
    const forwarded = databaseProcessEnv({
      DATABASE_URL: "postgres://u:p@db.test/app?sslmode=require",
      AIVEN_PG_CA: certificate,
    });
    expect(forwarded.AIVEN_PG_CA).not.toMatch(/[\r\n]/);
    expect(readDatabaseConfig(forwarded)).toEqual({
      DATABASE_URL: "postgres://u:p@db.test/app?sslmode=verify-full",
      AIVEN_PG_CA: certificate,
    });
    expect(
      readDatabaseConfig({
        DATABASE_URL: "postgres://u:p@db.test/app",
        AIVEN_PG_CA: certificate.replace(/\n/g, "\\n"),
      }).AIVEN_PG_CA,
    ).toBe(certificate);
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
