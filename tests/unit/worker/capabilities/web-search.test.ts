import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../../../src/worker/capabilities";

describe("disabled legacy web_search capability", () => {
  it("retains the compatibility identifier for skill authorization", () => {
    const registry = createCapabilityRegistry();
    expect(registry.requests(["web_search"])).toEqual([
      expect.objectContaining({ id: "web_search" }),
    ]);
    expect(registry.generalRequests()).toEqual([]);
  });

  it("cannot execute a standalone compatibility search", async () => {
    const audit = vi.fn();
    await expect(
      createCapabilityRegistry().invoke(
        "web_search",
        { query: "news" },
        ["web_search"],
        audit,
      ),
    ).rejects.toThrow("WEB_SEARCH_DISABLED");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "web_search",
        outcome: "failure",
      }),
    );
  });
});
