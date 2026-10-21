import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimWebhookFailure,
  releaseWebhookFailure,
  resetWebhookFailureClaims,
  webhookFailureClaimed,
} from "../../../../src/app/api/telegram/webhook/failure-ack";

describe("in-memory webhook failure acknowledgements", () => {
  beforeEach(() => resetWebhookFailureClaims());
  afterEach(() => vi.useRealTimers());

  it("lets only one concurrent caller reserve a failure notice", async () => {
    expect(
      await Promise.all([claimWebhookFailure("4"), claimWebhookFailure("4")]),
    ).toEqual([true, false]);
    await expect(webhookFailureClaimed("4")).resolves.toBe(true);
    await releaseWebhookFailure("4");
    await expect(webhookFailureClaimed("4")).resolves.toBe(false);
    await expect(claimWebhookFailure("4")).resolves.toBe(true);
  });

  it("expires old claims", async () => {
    vi.useFakeTimers();
    await claimWebhookFailure("4");
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await expect(webhookFailureClaimed("4")).resolves.toBe(false);
    await expect(claimWebhookFailure("4")).resolves.toBe(true);
  });
});
