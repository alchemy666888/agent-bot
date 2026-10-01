import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillCatalogOrEmpty } from "../../../../src/server/telegram/dispatch";

describe("Telegram dispatch skill catalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the validated catalog when GitHub is available", async () => {
    const catalog = { commitSha: "a".repeat(40), skills: [] };

    await expect(
      loadSkillCatalogOrEmpty(async () => catalog, "correlation-id"),
    ).resolves.toEqual(catalog);
  });

  it("continues without skills when GitHub Connect is unavailable", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      loadSkillCatalogOrEmpty(async () => {
        throw new Error("connector response containing private detail");
      }, "correlation-id"),
    ).resolves.toEqual({ commitSha: "0".repeat(40), skills: [] });

    expect(log).toHaveBeenCalledOnce();
    const event = JSON.parse(log.mock.calls[0]![0]);
    expect(event).toMatchObject({
      correlationId: "correlation-id",
      operation: "skill.catalog_load",
      result: "degraded",
      code: "GITHUB_CATALOG_UNAVAILABLE",
    });
    expect(log.mock.calls[0]![0]).not.toContain("private detail");
  });
});
