import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { uuidV7 } from "../../../src/shared/ids";

const exec = promisify(execFile);

describe("worker bundle", () => {
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
          input: { kind: "ignored", updateId: "1" },
          skillCatalog: { commitSha: "a".repeat(40), skills: [] },
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
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
