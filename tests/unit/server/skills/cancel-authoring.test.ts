import { describe, expect, it, vi } from "vitest";
import { SkillAuthoringService } from "../../../../src/server/skills/service";
import type { SkillAuthoringRepository } from "../../../../src/server/skills/service";
import type { SkillDraft } from "../../../../src/worker/skills/types";

function memoryRepository(): SkillAuthoringRepository & {
  current?: SkillDraft;
} {
  const repository: SkillAuthoringRepository & { current?: SkillDraft } = {
    current: undefined,
    async begin(draft) {
      repository.current = draft;
      return draft;
    },
    async activeForOwner() {
      const draft = repository.current;
      if (!draft || ["installed", "cancelled"].includes(draft.status))
        return undefined;
      return draft;
    },
    async processedUpdate() {
      return undefined;
    },
    async save(draft) {
      repository.current = draft;
      return draft;
    },
    async commitRevision() {
      throw new Error("should not commit");
    },
    async publish() {
      throw new Error("should not publish");
    },
  };
  return repository;
}

describe("server skill authoring cancellation", () => {
  it.each([
    ["no, stop creating AI skill", "cancelled"],
    ["停，不需要生成AI skill", "已取消"],
    ["不需要，停止", "已取消"],
  ])("cancels an open draft when the user says %j", async (text, expected) => {
    const repository = memoryRepository();
    const generateSkillDraft = vi.fn(async () => {
      throw new Error("should not generate");
    });
    const service = new SkillAuthoringService(repository, {
      generateSkillDraft,
    });

    await service.handle("42", "Create a skill", "1");
    const response = await service.handle("42", text, "2");

    expect(response).toContain(expected);
    expect(await repository.activeForOwner("42")).toBeUndefined();
    expect(generateSkillDraft).not.toHaveBeenCalled();
  });
});
