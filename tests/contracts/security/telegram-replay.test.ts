import { describe, expect, it } from "vitest";
import {
  advanceUpdate,
  type UpdateState,
} from "../../../src/worker/updates/state-machine";

describe("Telegram replay security contract", () => {
  it("keeps a terminal update immutable when Telegram replays its update ID", () => {
    const terminal: UpdateState = {
      updateId: "8675309",
      stage: "delivery_complete",
      assistantId: "answer-1",
      updatedAt: "2026-01-02T03:04:05.000Z",
    };
    const replay: UpdateState = {
      updateId: terminal.updateId,
      stage: "received",
      updatedAt: "2026-01-02T03:05:05.000Z",
    };
    expect(advanceUpdate(terminal, replay)).toBe(terminal);
  });
});
