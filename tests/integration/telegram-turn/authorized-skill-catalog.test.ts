import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../../../src/shared/contracts";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
import { DurableConversationService } from "../../../src/worker/conversations/durable-service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { initializeLayout } from "../../../src/worker/persistence/layout";
import { SkillResolver } from "../../../src/worker/skills/resolver";
import { UpdateRepository } from "../../../src/worker/updates/repository";
import type { ExecutableSkill } from "../../../src/worker/skills/schemas";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const commitSha = "a".repeat(40);
function skill(id: string, name: string): ExecutableSkill {
  return {
    id,
    name,
    description: `${name} description`,
    commitSha,
    manifestRevision: 1,
    instructions: `${name} instructions`,
    visibility: "private",
    ownerTelegramUserIds: ["3"],
    allowedTelegramUserIds: [],
    triggers: {
      phrases: [],
      keywords: [name.toLowerCase()],
      minimumConfidence: 1,
    },
    tools: [],
    prohibitedActions: [],
    status: "active",
  };
}

const reports = skill("11111111-1111-4111-8111-111111111111", "Reports");
const calendar = skill("22222222-2222-4222-8222-222222222222", "Calendar");
const unauthorized = skill("33333333-3333-4333-8333-333333333333", "Secret");

async function run(text: string) {
  root = await mkdtemp(join(tmpdir(), "authorized-catalog-"));
  await initializeLayout(root);
  const locks = new LockCoordinator(root);
  const requests: ModelRequest[] = [];
  const resolver = new SkillResolver(new CapabilityRegistry([]), [
    reports,
    calendar,
    unauthorized,
  ]);
  const catalog = Object.freeze({ commitSha, skills: [reports, calendar] });
  const turn = new TelegramTurn(
    locks,
    new UpdateRepository(root),
    new DurableConversationService(root, locks),
    {
      generate: vi.fn(async (request: ModelRequest) => {
        requests.push(request);
        return { content: "done" };
      }),
    },
    { typing: vi.fn(async () => {}), send: vi.fn(async () => {}) },
    "system",
    undefined,
    undefined,
    resolver,
    [],
    undefined,
    undefined,
    60_000,
    { mode: "enforced" },
    catalog,
  );
  await turn.handle({
    kind: "text",
    updateId: String(Date.now()),
    messageId: "1",
    chatId: "2",
    userId: "3",
    text,
  });
  return requests;
}

describe("trusted authorized skill catalog", () => {
  it("includes the complete filtered, commit-pinned catalog on direct requests", async () => {
    const [request] = await run("hello there");
    expect(request.executionMode).toBe("direct");
    expect(request.authorizedSkillCatalog?.commitSha).toBe(commitSha);
    expect(request.authorizedSkillCatalog?.skills.map(({ id }) => id)).toEqual([
      reports.id,
      calendar.id,
    ]);
    expect(request.authorizedSkillCatalog?.skills).not.toContainEqual(
      unauthorized,
    );
  });

  it("keeps the complete snapshot on selected-skill requests", async () => {
    const [request] = await run(`/use ${reports.id} prepare reports`);
    expect(request.executionMode).toBe("selected_skill");
    expect(request.skill?.id).toBe(reports.id);
    expect(request.authorizedSkillCatalog).toEqual({
      commitSha,
      skills: [reports, calendar],
    });
  });
});
