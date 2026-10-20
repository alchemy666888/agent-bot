import { describe, expect, it } from "vitest";
import {
  MAX_TURN_TIMEOUT_MS,
  WORKER_COMMAND_TIMEOUT_MS,
  clampTurnTimeout,
} from "../../../src/shared/worker-budget";

describe("turn budget", () => {
  it("clamps a deadline that would meet the worker command timeout", () => {
    expect(MAX_TURN_TIMEOUT_MS).toBeLessThan(WORKER_COMMAND_TIMEOUT_MS);
    expect(clampTurnTimeout(undefined)).toBe(MAX_TURN_TIMEOUT_MS);
    expect(clampTurnTimeout(60_000)).toBe(60_000);
    expect(clampTurnTimeout(MAX_TURN_TIMEOUT_MS)).toBe(MAX_TURN_TIMEOUT_MS);
    expect(clampTurnTimeout(WORKER_COMMAND_TIMEOUT_MS)).toBe(
      MAX_TURN_TIMEOUT_MS,
    );
    expect(clampTurnTimeout(600_000)).toBe(MAX_TURN_TIMEOUT_MS);
  });
});
