import { describe, expect, it, vi } from "vitest";
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
});
