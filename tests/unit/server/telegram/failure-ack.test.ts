import { describe, expect, it, beforeEach } from "vitest";
import {
  claimWebhookFailure,
  releaseWebhookFailure,
  resetWebhookFailureClaims,
  webhookFailureAckPath,
  webhookFailureClaimed,
} from "../../../../src/app/api/telegram/webhook/failure-ack";

describe("webhook failure ack", () => {
  beforeEach(() => {
    resetWebhookFailureClaims();
  });

  it("stores the ack beside controller logs so the worker scratch does not sync it", () => {
    expect(webhookFailureAckPath("15")).toBe(
      "logs/controller/webhook-ack-15.json",
    );
    expect(webhookFailureAckPath("15")).not.toMatch(/^data\/|^logs\/worker\//);
    expect(webhookFailureAckPath("nope")).toBeUndefined();
    expect(webhookFailureAckPath("../2")).toBeUndefined();
  });

  it("lets one caller reserve an update and releases that reservation", async () => {
    await expect(claimWebhookFailure("4", "corr")).resolves.toBe(true);
    await expect(webhookFailureClaimed("4")).resolves.toBe(true);
    await expect(claimWebhookFailure("4", "corr")).resolves.toBe(false);
    await releaseWebhookFailure("4");
    await expect(webhookFailureClaimed("4")).resolves.toBe(false);
    await expect(claimWebhookFailure("4", "again")).resolves.toBe(true);
  });
});
