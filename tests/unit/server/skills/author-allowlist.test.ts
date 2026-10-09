import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresSkillAuthoringRepository } from "../../../../src/server/skills/repository";
import { MemorySkillDefinitionStore } from "../../../../src/worker/skills/definition-store";
import type { SkillDraft } from "../../../../src/worker/skills/types";
import {
  isTelegramActorAllowed,
  parseTelegramAllowlist,
} from "../../../../src/shared/telegram-allowlist";

function draft(ownerTelegramUserId: string): SkillDraft {
  const now = "2026-10-02T00:00:00.000Z";
  return {
    id: "draft-1",
    stableId: "stable-1",
    ownerTelegramUserId,
    skillName: null,
    intendedTasksDomain: null,
    mustDo: [],
    mustNotDo: [],
    betterToDo: [],
    requiredToolsFunctions: [],
    unresolvedQuestions: [],
    draftContent: null,
    revisionNumber: 0,
    status: "clarifying",
    createdAt: now,
    updatedAt: now,
    installedAt: null,
    lastProcessedUpdateId: null,
    lastResponse: null,
    versionId: null,
    contentDigest: null,
  };
}

function repository(value: string) {
  const authors = parseTelegramAllowlist(value);
  return new PostgresSkillAuthoringRepository(
    {} as Pool,
    new MemorySkillDefinitionStore(),
    {
      authorTelegramUserIds: authors.ids,
      authorTelegramUsernames: authors.usernames,
      capabilityIds: new Set(),
    },
  );
}

describe("Telegram author allowlist", () => {
  it("keeps a configured username that is not a numeric Telegram ID", () => {
    expect(parseTelegramAllowlist("luckyvickyforever")).toEqual({
      ids: new Set(),
      usernames: new Set(["luckyvickyforever"]),
    });
    expect(
      isTelegramActorAllowed(
        parseTelegramAllowlist("@LuckyVickyForever"),
        "42",
        "LuckyVickyForever",
      ),
    ).toBe(true);
  });

  it("starts a draft for the configured username and still requires an exact identity", async () => {
    const allowed = repository("luckyvickyforever");
    await expect(
      allowed.begin(draft("42"), "luckyvickyforever"),
    ).resolves.toMatchObject({
      ownerTelegramUserId: "42",
      versionId: null,
    });
    await expect(allowed.begin(draft("42"))).rejects.toThrow(
      "SKILL_AUTHOR_NOT_AUTHORIZED",
    );
    await expect(allowed.begin(draft("42"), "someoneelse")).rejects.toThrow(
      "SKILL_AUTHOR_NOT_AUTHORIZED",
    );

    const numeric = repository("42");
    await expect(numeric.begin(draft("42"))).resolves.toMatchObject({
      ownerTelegramUserId: "42",
    });
  });
});
