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
});
