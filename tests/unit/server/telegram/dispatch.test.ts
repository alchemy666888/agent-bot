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
import { getToken } from "@vercel/connect";
import { invokeWorker } from "../../../../src/server/sandbox/transport";
import { workerRequestSchema } from "../../../../src/shared/contracts/worker";
import { compiledEmergencyBundle } from "../../../../src/worker/prompts/bundle";
import type { GitHubPromptStore } from "../../../../src/server/prompts/github-store";
import { SkillAuthoringService } from "../../../../src/server/skills/service";
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
    }))
      vi.stubEnv(key, value);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  const input = {
    kind: "text" as const,
    updateId: "1",
    messageId: "2",
    chatId: "3",
    userId: "4",
    text: "今天香港天氣怎樣？",
  };

  it("loads remote main even with prompts disabled and never consults active drafts", async () => {
    const shouldHandle = vi
      .spyOn(SkillAuthoringService.prototype, "shouldHandle")
      .mockResolvedValue(true);
    const commit = "a".repeat(40);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ object: { type: "commit", sha: commit } }),
      )
      .mockResolvedValueOnce(fileResponse({ schemaVersion: 1, skills: [] }));
    await dispatchTelegramInput(input);
    expect(shouldHandle).not.toHaveBeenCalled();
    expect(String(fetcher.mock.calls[0]![0])).toMatch(
      /\/git\/ref\/heads\/main$/,
    );
    expect(String(fetcher.mock.calls[1]![0])).toContain(`?ref=${commit}`);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("obsolete-draft");
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: commit,
      payload: { skillCatalog: { commitSha: commit } },
    });
  });

  it.each([404, 403, 500])(
    "continues to the worker when GitHub returns %s",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("", { status }),
      );
      await expect(dispatchTelegramInput(input)).resolves.toMatchObject({
        ok: true,
      });
      const request = vi.mocked(invokeWorker).mock.calls[0]![2];
      expect(workerRequestSchema.safeParse(request).success).toBe(true);
      expect(request).toMatchObject({
        repositoryCommitSha: null,
        degradationNotices: expect.arrayContaining(["repository_unavailable"]),
      });
    },
  );

  it("continues when connector access fails before a head is resolved", async () => {
    vi.mocked(getToken).mockRejectedValueOnce(
      new Error("connector unavailable"),
    );
    await expect(dispatchTelegramInput(input)).resolves.toMatchObject({
      ok: true,
    });
    expect(vi.mocked(invokeWorker).mock.calls[0]![2]).toMatchObject({
      repositoryCommitSha: null,
    });
  });

  it.each(["missing", "invalid"])(
    "preserves main's pin when the catalog is %s",
    async (kind) => {
      const commit = "b".repeat(40);
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ object: { type: "commit", sha: commit } }),
        )
        .mockResolvedValueOnce(
          kind === "missing"
            ? new Response("", { status: 404 })
            : fileResponse({ bogus: true }),
        );
      await dispatchTelegramInput(input);
      const request = vi.mocked(invokeWorker).mock.calls[0]![2];
      expect(workerRequestSchema.safeParse(request).success).toBe(true);
      expect(request).toMatchObject({
        repositoryCommitSha: commit,
        payload: { skillCatalog: { commitSha: commit, skills: [] } },
      });
    },
  );

  it("falls back without a pin when GitHub returns an invalid head", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ object: { type: "commit", sha: "invalid" } }),
    );
    await dispatchTelegramInput(input);
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: null,
      payload: { skillCatalog: { skills: [] } },
    });
  });

  it("retrieves a usable skill from main and observes a new main head next turn", async () => {
    const id = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0";
    const manifest = {
      schemaVersion: 1,
      id,
      name: "weather",
      description: "Current weather",
      visibility: "public",
      ownerTelegramUserIds: ["4"],
      triggers: { phrases: ["天氣"], minimumConfidence: 1 },
      tools: ["web_search"],
    };
    const commits = ["a".repeat(40), "b".repeat(40)];
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const commit of commits) {
      fetcher
        .mockResolvedValueOnce(
          Response.json({ object: { type: "commit", sha: commit } }),
        )
        .mockResolvedValueOnce(
          fileResponse({
            schemaVersion: 1,
            skills: [{ id, directory: "weather" }],
          }),
        )
        .mockResolvedValueOnce(fileResponse(manifest))
        .mockResolvedValueOnce(
          fileResponse(
            "---\nname: weather\ndescription: Current weather\n---\nSearch current weather.",
          ),
        );
    }
    await dispatchTelegramInput(input);
    await dispatchTelegramInput({ ...input, updateId: "2" });
    for (const [index, commit] of commits.entries()) {
      const request = vi.mocked(invokeWorker).mock.calls[index]![2];
      expect(workerRequestSchema.safeParse(request).success).toBe(true);
      expect(request).toMatchObject({
        repositoryCommitSha: commit,
        payload: { skillCatalog: { skills: [{ id, commitSha: commit }] } },
      });
      expect(String(fetcher.mock.calls[index * 4]![0])).toMatch(
        /\/git\/ref\/heads\/main$/,
      );
      for (const call of fetcher.mock.calls.slice(index * 4 + 1, index * 4 + 4))
        expect(String(call[0])).toContain(`?ref=${commit}`);
    }
  });

  it("drops skills requiring unavailable capabilities so the worker can fall back", async () => {
    const commit = "e".repeat(40);
    const id = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ object: { type: "commit", sha: commit } }),
      )
      .mockResolvedValueOnce(
        fileResponse({
          schemaVersion: 1,
          skills: [{ id, directory: "weather" }],
        }),
      )
      .mockResolvedValueOnce(
        fileResponse({
          schemaVersion: 1,
          id,
          name: "weather",
          visibility: "public",
          ownerTelegramUserIds: ["4"],
          triggers: { phrases: ["天氣"], minimumConfidence: 1 },
          tools: ["unknown_tool"],
        }),
      )
      .mockResolvedValueOnce(
        fileResponse(
          "---\nname: weather\ndescription: Weather\n---\nUse unknown_tool.",
        ),
      );
    await dispatchTelegramInput(input);
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: commit,
      payload: { skillCatalog: { skills: [] } },
    });
  });

  it("keeps the main pin and continues when enabled repository prompts cannot load", async () => {
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
    const commit = "d".repeat(40);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ object: { type: "commit", sha: commit } }),
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    await dispatchTelegramInput(input);
    expect(load).toHaveBeenCalledWith(commit);
    const request = vi.mocked(invokeWorker).mock.calls[0]![2];
    expect(workerRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      repositoryCommitSha: commit,
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

function fileResponse(value: unknown) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return Response.json({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
    size: Buffer.byteLength(content),
    sha: "c".repeat(40),
    path: "skills/index.json",
    name: "index.json",
  });
}
