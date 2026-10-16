import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  failureContext,
  sanitizeProgress,
} from "../../../../src/shared/worker-progress";
import { writeWorkerProgress } from "../../../../src/worker/observability/progress";

describe("worker progress", () => {
  it("keeps only allowlisted progress fields", () => {
    expect(
      sanitizeProgress({
        stage: "model",
        elapsedMs: 10,
        attempt: 1,
        iteration: 0,
        executionMode: "forced_web_search",
        tool: "web_search",
        prompt: "CPI",
        secret: "sk-secret",
      }),
    ).toEqual({
      stage: "model",
      elapsedMs: 10,
      attempt: 1,
      iteration: 0,
      executionMode: "forced_web_search",
      tool: "web_search",
    });
    expect(sanitizeProgress({ stage: "Model", elapsedMs: 1 })).toBeUndefined();
    expect(sanitizeProgress({ stage: "model", elapsedMs: -1 })).toBeUndefined();
  });

  it("reads command context without copying stderr", () => {
    expect(
      failureContext(
        Object.assign(new Error("WORKER_COMMAND_TIMEOUT"), {
          operation: "telegramTurn",
          timeoutLimitMs: 250_000,
          progress: { stage: "tool", elapsedMs: 90_000, tool: "news" },
          stderr: "Bearer sk-secret",
        }),
      ),
    ).toEqual({
      operation: "telegramTurn",
      timeoutLimitMs: 250_000,
      progress: { stage: "tool", elapsedMs: 90_000, tool: "news" },
    });
  });

  it("writes the progress file only at the controller-supplied path", async () => {
    const root = await mkdtemp(join(tmpdir(), "progress-"));
    const target = join(root, "not-the-progress-path.json");
    await writeWorkerProgress(
      { stage: "model", elapsedMs: 5 },
      { WORKER_PROGRESS_FILE: target },
    );
    await expect(readFile(target, "utf8")).rejects.toThrow();

    const allowed = "/tmp/telegram-agent/progress/correlation-id.json";
    await writeWorkerProgress(
      { stage: "model", elapsedMs: 5, prompt: "hidden" } as never,
      { WORKER_PROGRESS_FILE: allowed },
    );
    expect(JSON.parse(await readFile(allowed, "utf8"))).toEqual({
      stage: "model",
      elapsedMs: 5,
    });
  });
});
