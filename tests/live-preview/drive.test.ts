import { describe, expect, it } from "vitest";
import { SANDBOX_REGION } from "../../src/server/config";

describe("authorized sin1 preview", () => {
  it("refuses to run without the explicit preview gate", () => {
    expect(process.env.TELEGRAM_AGENT_LIVE_PREVIEW).toBe("authorized");
    expect(process.env.SANDBOX_DRIVE_NAME).toMatch(
      /^telegram-agent-preview-[a-z0-9-]+$/,
    );
    expect(process.env.SANDBOX_NAME).toMatch(
      /^telegram-agent-preview-[a-z0-9-]+$/,
    );
    expect(SANDBOX_REGION).toBe("sin1");
  });
});
