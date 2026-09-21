import { describe, expect, it } from "vitest";
import {
  modelResponseSchema,
  pageInputSchema,
  workerRequestSchema,
  workerResponseSchema,
} from "../../../src/shared/contracts";
import { telegramId, uuidV7 } from "../../../src/shared/ids";
import { redact } from "../../../src/shared/redaction";

describe("shared boundaries", () => {
  it("validates versioned worker messages", () => {
    const id = uuidV7();
    expect(
      workerRequestSchema.parse({
        contractVersion: 1,
        correlationId: id,
        operation: "health",
        payload: {},
      }),
    ).toBeTruthy();
    expect(
      workerResponseSchema.parse({
        contractVersion: 1,
        correlationId: id,
        ok: true,
        data: {},
      }),
    ).toBeTruthy();
    expect(() =>
      workerRequestSchema.parse({
        contractVersion: 2,
        correlationId: id,
        operation: "health",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      workerResponseSchema.parse({
        contractVersion: 1,
        correlationId: id,
        ok: true,
        data: {},
        error: { code: "BAD", classification: "internal", message: "bad" },
      }),
    ).toThrow();
  });
  it("rejects hidden reasoning and malformed view/model data", () => {
    expect(() =>
      modelResponseSchema.parse({ content: "ok", reasoning_content: "hidden" }),
    ).toThrow();
    expect(() => pageInputSchema.parse({ page: 0 })).toThrow();
  });
  it("creates UUIDv7 and decimal Telegram ids", () => {
    expect(uuidV7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(telegramId(123n)).toBe("123");
    expect(() => telegramId("1e3")).toThrow();
  });
  it("removes secret-shaped keys and values recursively", () => {
    const output = JSON.stringify(
      redact({
        authorization: "Bearer abc",
        nested: {
          cookie: "x",
          message: "Bearer abcdefghi",
          reasoning: "hidden",
        },
      }),
    );
    expect(output).not.toMatch(/authorization|cookie|reasoning|abcdefghi/i);
  });
});
