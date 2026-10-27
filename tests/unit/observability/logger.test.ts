import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  formatFailureDebug,
  logException,
  logStructured,
  safeError,
} from "../../../src/shared/logger";
import { uuidV7 } from "../../../src/shared/ids";

describe("sanitized observability", () => {
  it("redacts prohibited keys and secret-shaped values before logging", () => {
    const sink = vi.fn();
    logStructured(
      {
        correlationId: uuidV7(),
        component: "worker",
        operation: "telegramTurn",
        stage: "model",
        result: "failure",
        metadata: {
          authorization: "Bearer secret-value",
          reasoning: "private chain",
          note: "bot-abcdefghi",
        },
      },
      sink,
    );
    const line = sink.mock.calls[0]![0] as string;
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toMatch(/authorization|reasoning|secret-value|abcdefghi/i);
  });

  it("maps exceptions to bounded safe envelopes", () => {
    expect(
      safeError(
        Object.assign(new Error("DEEPSEEK_REQUEST_FAILED"), { status: 503 }),
      ),
    ).toMatchObject({
      code: "DEEPSEEK_REQUEST_FAILED",
      classification: "transient",
      message: "Temporary operation failure",
      detail: expect.stringContaining("status=503"),
    });
    const secret = safeError(new Error("Bearer bot-verysecretvalue"));
    expect(secret).toMatchObject({
      code: "INTERNAL_ERROR",
      classification: "permanent",
      message: "Operation failed",
    });
    expect(JSON.stringify(secret)).not.toMatch(/bot-verysecretvalue|Bearer/i);
    expect(secret.detail).toContain("[REDACTED]");
  });

  it("reports allowlisted diagnostics and a redacted error chain", () => {
    const error = Object.assign(
      new TypeError("postgres://user:secret@example.test/private"),
      { code: "ECONNRESET", status: 503 },
    );
    const failure = safeError(error, "INTERNAL_ERROR", "persistence-sync");
    expect(failure).toMatchObject({
      code: "INTERNAL_ERROR",
      classification: "transient",
      message: "Temporary operation failure",
      diagnostic: {
        stage: "persistence-sync",
        kind: "TypeError",
        causeCode: "ECONNRESET",
        status: 503,
      },
    });
    expect(failure.detail).toContain("code=ECONNRESET");
    expect(failure.detail).toContain("status=503");
    expect(failure.trace?.[0]).toMatch(/^at /);
    expect(failure.trace?.join("\n")).not.toMatch(/\/workspace\/|\/home\//);
    expect(JSON.stringify(failure)).not.toMatch(/secret|postgres:\/\//i);
  });

  it("identifies an unreachable database network from its structured cause", () => {
    const error = Object.assign(new Error("connect ENETUNREACH private-host"), {
      code: "ENETUNREACH",
    });
    expect(
      safeError(error, "INTERNAL_ERROR", "persistence-sync"),
    ).toMatchObject({
      code: "DATABASE_NETWORK_UNREACHABLE",
      classification: "permanent",
      message: "Operation failed",
      diagnostic: {
        stage: "persistence-sync",
        kind: "Error",
        causeCode: "ENETUNREACH",
      },
    });
  });

  it("names invalid configuration fields without copying their values", () => {
    let error: unknown;
    try {
      z.object({
        DEEPSEEK_THINKING_ENABLED: z.enum(["true", "false"]),
        DATABASE_URL: z.url({ protocol: /^postgres$/ }),
      }).parse({
        DEEPSEEK_THINKING_ENABLED: "",
        DATABASE_URL: "https://user:super-secret@db.internal/app",
      });
    } catch (caught) {
      error = caught;
    }

    const failure = safeError(error, "INTERNAL_ERROR", "dispatch");
    expect(failure.code).toBe("CONFIGURATION_INVALID");
    expect(failure.diagnostic?.issues).toEqual([
      "DEEPSEEK_THINKING_ENABLED:invalid_value",
      "DATABASE_URL:invalid_format",
    ]);
    expect(JSON.stringify(failure)).not.toContain("super-secret");
  });

  it("identifies a database DNS failure from its structured cause", () => {
    const error = Object.assign(
      new Error("getaddrinfo ENOTFOUND private-host"),
      {
        code: "ENOTFOUND",
      },
    );
    const failure = safeError(error, "INTERNAL_ERROR", "persistence-sync");
    expect(failure).toMatchObject({
      code: "DATABASE_HOST_NOT_FOUND",
      classification: "permanent",
      message: "Operation failed",
      diagnostic: {
        stage: "persistence-sync",
        kind: "Error",
        causeCode: "ENOTFOUND",
      },
    });
    expect(failure.detail).toContain("ENOTFOUND");
    expect(failure.detail).toContain("private-host");
  });

  it("includes the last worker progress in a private failure message", () => {
    const failure = safeError(
      Object.assign(new Error("WORKER_COMMAND_TIMEOUT"), {
        operation: "telegramTurn",
        timeoutLimitMs: 250_000,
        progress: {
          stage: "model",
          elapsedMs: 248_000,
          iteration: 2,
          executionMode: "forced_web_search",
          tool: "web_search",
          prompt: "CPI數據",
        },
      }),
      "INTERNAL_ERROR",
      "dispatch",
    );
    expect(failure.classification).toBe("transient");
    const text = formatFailureDebug({
      headline: "這次回覆沒有完成，請再傳一次。",
      correlationId: uuidV7(),
      durationMs: 255_230,
      source: "dispatch",
      updateId: "566922337",
      inputKind: "text",
      context: {
        operation: "telegramTurn",
        timeoutLimitMs: 250_000,
        progress: {
          stage: "model",
          elapsedMs: 248_000,
          iteration: 2,
          executionMode: "forced_web_search",
          tool: "web_search",
        },
      },
      failure,
    });
    expect(text).toContain("timeoutLimitMs: 250000");
    expect(text).toContain("workerStage: model");
    expect(text).toContain("workerElapsedMs: 248000");
    expect(text).toContain("iteration: 2");
    expect(text).toContain("executionMode: forced_web_search");
    expect(text).toContain("tool: web_search");
    expect(text).not.toContain("CPI");
  });
});

describe("Vercel runtime logging", () => {
  it("routes failure logs to Error, degraded logs to Warning, and success to Info", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const context = { correlationId: uuidV7(), component: "controller" as const, operation: "test", stage: "dispatch" };
      logStructured({ ...context, result: "failure" });
      logStructured({ ...context, result: "degraded" });
      logStructured({ ...context, result: "success" });
      expect(JSON.parse(error.mock.calls[0]![0] as string).level).toBe("error");
      expect(JSON.parse(warning.mock.calls[0]![0] as string).level).toBe("warning");
      expect(JSON.parse(info.mock.calls[0]![0] as string).level).toBe("info");
      expect(error).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps root causes and their frames when the outer error is long", () => {
    const cause = Object.assign(new Error("socket failed"), { code: "ECONNRESET" });
    cause.stack = "Error: socket failed\n    at connect (/private/server/socket.ts:7:3)";
    const error = new Error("outer ".repeat(500), { cause });
    const line = logException(error, { correlationId: uuidV7(), component: "controller" as const, operation: "test", stage: "dispatch" }, () => undefined);
    const record = JSON.parse(line);
    expect(record.metadata.error.detail).toContain("Root cause: Error (code=ECONNRESET): socket failed");
    expect(record.metadata.error.trace[0]).toContain("socket.ts:7:3");
    expect(record.metadata.causes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "error.cause", message: "socket failed", annotations: "code=ECONNRESET" }),
    ]));
    expect(line).not.toContain("/private/server");
  });

  it("bounds cyclic aggregate exceptions and removes URL credentials and Telegram tokens", () => {
    const error = new AggregateError([
      new Error("https://api.telegram.org/bot123456789:AA_fixture_secret_value/sendMessage"),
      new Error("postgres://user:fixturepass@db.example/app"),
    ], "request failed");
    Object.assign(error, { cause: error });
    const line = logException(error, { correlationId: uuidV7(), component: "controller" as const, operation: "test", stage: "dispatch" }, () => undefined);
    const record = JSON.parse(line);
    expect(record.metadata.causes.length).toBeLessThanOrEqual(8);
    expect(record.metadata.error.detail.length).toBeLessThanOrEqual(1800);
    expect(line).not.toMatch(/AA_fixture_secret_value|fixturepass|123456789:/);
  });
});
