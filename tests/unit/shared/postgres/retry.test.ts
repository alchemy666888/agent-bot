import { describe, expect, it, vi } from "vitest";

import {
  isTransientPersistenceError,
  retryPersistence,
} from "../../../../src/shared/postgres/retry";

describe("PostgreSQL persistence retries", () => {
  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT",
  ])("treats %s as transient", (code) => {
    expect(
      isTransientPersistenceError(Object.assign(new Error(), { code })),
    ).toBe(true);
  });

  it("retries a transient DNS failure", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOTFOUND" }))
      .mockResolvedValue("connected");

    const result = retryPersistence(operation);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe("connected");
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
