import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { uuidV7 } from "../../../src/shared/ids";
import { EMPTY_SKILL_CATALOG_TOKEN } from "../../../src/worker/skills/schemas";

const exec = promisify(execFile);

describe("worker bundle", () => {
  it("byte-verifies the release artifact and rejects stale output", async () => {
    await exec("pnpm", ["worker:build"]);
    await exec("pnpm", ["worker:verify"]);
    await appendFile("dist/worker.mjs", "\n// stale artifact\n");
    try {
      await expect(exec("pnpm", ["worker:verify"])).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      await exec("pnpm", ["worker:build"]);
    }
  }, 15_000);

  it("starts as ESM with bundled CommonJS dependencies", async () => {
    await exec("pnpm", ["worker:build"]);
    const root = await mkdtemp(join(tmpdir(), "worker-bundle-"));
    const correlationId = uuidV7();
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        contractVersion: 1,
        correlationId,
        operation: "health",
        payload: {},
      }),
    );
    const env = { ...process.env };
    delete env.DATABASE_URL;
    try {
      await exec(
        process.execPath,
        ["dist/worker.mjs", "health", requestPath, responsePath],
        { env },
      );
      expect(JSON.parse(await readFile(responsePath, "utf8"))).toEqual({
        contractVersion: 1,
        correlationId,
        ok: true,
        data: {},
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes a v2 prompt bundle and sends its reviewed layers to the provider", async () => {
    await exec("pnpm", ["worker:build"]);
    const root = await mkdtemp(join(tmpdir(), "worker-v2-bundle-"));
    const correlationId = uuidV7();
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    const capturePath = join(root, "provider-request.json");
    const preloadPath = join(root, "stub-fetch.mjs");
    const sha = "a".repeat(40);
    await writeFile(
      preloadPath,
      `import { writeFile } from "node:fs/promises";
globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith("/responses")) {
    await writeFile(process.env.PROVIDER_CAPTURE_PATH, String(init.body));
    return new Response(JSON.stringify({ id: "stub-request", output_text: "stub answer", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
};\n`,
    );
    await writeFile(
      requestPath,
      JSON.stringify({
        contractVersion: 2,
        correlationId,
        operation: "telegramTurn",
        repositoryCommitSha: sha,
        payload: {
          input: {
            kind: "text",
            updateId: "101",
            messageId: "102",
            chatId: "103",
            userId: "104",
            text: "contract smoke input",
          },
          skillCatalog: { catalogToken: EMPTY_SKILL_CATALOG_TOKEN, skills: [] },
        },
        promptBundle: {
          schemaVersion: 1,
          runtimePolicy: { version: "2", mode: "normal" },
          commonSystemPrompt: {
            id: "common-contract-smoke",
            content: "reviewed common contract prompt",
            source: "repository",
            blobSha: sha,
          },
          personalOverlay: {
            id: "personal-contract-smoke",
            content: "reviewed personal contract prompt",
            source: "repository",
            blobSha: sha,
          },
          requestTemplate: {
            id: "request-contract-smoke",
            content: "reviewed request contract template",
            source: "repository",
            blobSha: sha,
          },
          trustedRuntimeContext: [],
          repositoryCommitSha: sha,
          selectedBlobShas: [
            { promptId: "common-contract-smoke", blobSha: sha },
            { promptId: "personal-contract-smoke", blobSha: sha },
            { promptId: "request-contract-smoke", blobSha: sha },
          ],
          resolutionSource: "explicit",
          degradedModeSource: null,
          turnPin: { commitSha: sha, pinnedAt: "2026-10-02T00:00:00.000Z" },
          telemetry: { resolution: "exact", degraded: false },
        },
        rawTelegramInput: "contract smoke input",
      }),
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: "",
      TELEGRAM_AGENT_ROOT: join(root, "state"),
      PROVIDER_CAPTURE_PATH: capturePath,
      TELEGRAM_BOT_TOKEN: "stub-telegram-token",
      DEEPSEEK_API_KEY: "stub-provider-key",
      DEEPSEEK_BASE_URL: "https://provider.invalid",
      DEEPSEEK_THINKING_ENABLED: "false",
      SKILLS_ENABLED: "false",
    };
    delete env.DATABASE_URL;
    delete env.AIVEN_PG_CA;
    try {
      await exec(
        process.execPath,
        [
          "--import",
          preloadPath,
          "dist/worker.mjs",
          "telegramTurn",
          requestPath,
          responsePath,
        ],
        {
          env,
        },
      );
      expect(JSON.parse(await readFile(responsePath, "utf8"))).toMatchObject({
        contractVersion: 2,
        correlationId,
        ok: true,
      });
      const providerRequest = JSON.parse(await readFile(capturePath, "utf8"));
      expect(providerRequest.instructions).toContain(
        "reviewed common contract prompt",
      );
      expect(providerRequest.instructions).toContain(
        "reviewed personal contract prompt",
      );
      expect(JSON.stringify(providerRequest.input)).toContain(
        "reviewed request contract template",
      );
      expect(JSON.stringify(providerRequest.input)).not.toContain(
        "contract smoke input",
      );
      expect(JSON.stringify(providerRequest.input)).toContain(
        Buffer.from("contract smoke input").toString("base64"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("acknowledges ignored updates without model configuration", async () => {
    await exec("pnpm", ["worker:build"]);
    const root = await mkdtemp(join(tmpdir(), "worker-ignored-"));
    const correlationId = uuidV7();
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        contractVersion: 1,
        correlationId,
        operation: "telegramTurn",
        payload: {
          input: { kind: "ignored", updateId: "1" },
          skillCatalog: {
            catalogToken: EMPTY_SKILL_CATALOG_TOKEN,
            skills: [],
          },
        },
      }),
    );
    const env = { ...process.env };
    for (const name of [
      "DATABASE_URL",
      "TELEGRAM_BOT_TOKEN",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "DEEPSEEK_THINKING_ENABLED",
      "ASSISTANT_SYSTEM_PROMPT",
    ])
      delete env[name];
    try {
      await exec(
        process.execPath,
        ["dist/worker.mjs", "telegramTurn", requestPath, responsePath],
        { env },
      );
      expect(JSON.parse(await readFile(responsePath, "utf8"))).toEqual({
        contractVersion: 1,
        correlationId,
        ok: true,
        data: { terminal: true },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a safe structured response when an operation fails", async () => {
    await exec("pnpm", ["worker:build"]);
    const root = await mkdtemp(join(tmpdir(), "worker-bundle-"));
    const correlationId = uuidV7();
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        contractVersion: 1,
        correlationId,
        operation: "telegramTurn",
        payload: {
          input: {
            kind: "text",
            updateId: "1",
            messageId: "2",
            chatId: "3",
            userId: "4",
            text: "hello",
          },
          skillCatalog: {
            catalogToken: EMPTY_SKILL_CATALOG_TOKEN,
            skills: [],
          },
        },
      }),
    );
    const env = { ...process.env };
    for (const name of [
      "DATABASE_URL",
      "TELEGRAM_BOT_TOKEN",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "DEEPSEEK_THINKING_ENABLED",
      "ASSISTANT_SYSTEM_PROMPT",
    ])
      delete env[name];
    try {
      await exec(
        process.execPath,
        ["dist/worker.mjs", "telegramTurn", requestPath, responsePath],
        { env },
      );
      expect(JSON.parse(await readFile(responsePath, "utf8"))).toEqual({
        contractVersion: 1,
        correlationId,
        ok: false,
        error: {
          code: "WORKER_CONFIGURATION_INVALID",
          classification: "permanent",
          message: "Operation failed",
          diagnostic: {
            stage: "operation",
            kind: "Error",
            causeCode: "ASSISTANT_SYSTEM_PROMPT",
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
