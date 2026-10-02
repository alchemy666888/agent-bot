import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logStructured, safeError } from "../../../src/shared/logger";
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
    ).toEqual({
      code: "DEEPSEEK_REQUEST_FAILED",
      classification: "transient",
      message: "Temporary operation failure",
    });
    expect(safeError(new Error("Bearer bot-verysecretvalue"))).toEqual({
      code: "INTERNAL_ERROR",
      classification: "permanent",
      message: "Operation failed",
    });
  });

  it("reports allowlisted diagnostics without including exception messages", () => {
    const error = Object.assign(
      new TypeError("postgres://user:secret@example.test/private"),
      { code: "ECONNRESET", status: 503 },
    );
    expect(safeError(error, "INTERNAL_ERROR", "persistence-sync")).toEqual({
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
    expect(JSON.stringify(safeError(error))).not.toContain("secret");
  });

  it("identifies an unreachable database network from its structured cause", () => {
    const error = Object.assign(new Error("connect ENETUNREACH private-host"), {
      code: "ENETUNREACH",
    });
    expect(safeError(error, "INTERNAL_ERROR", "persistence-sync")).toEqual({
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
    expect(safeError(error, "INTERNAL_ERROR", "persistence-sync")).toEqual({
      code: "DATABASE_HOST_NOT_FOUND",
      classification: "permanent",
      message: "Operation failed",
      diagnostic: {
        stage: "persistence-sync",
        kind: "Error",
        causeCode: "ENOTFOUND",
      },
    });
  });
});
