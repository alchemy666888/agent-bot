import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { UpdateRepository } from "../../../src/worker/updates/repository";
import { ConversationService } from "../../../src/worker/conversations/service";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
import { DeepSeekProvider } from "../../../src/worker/model/deepseek";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { SkillResolver } from "../../../src/worker/skills/resolver";
import { skillCatalogSnapshotSchema } from "../../../src/worker/skills/schemas";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("skill routing acceptance", () => {
  it("loads a catalog, invokes its capability, and sends only final text", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-"));
    const commitSha = "a".repeat(40);
    const catalog = skillCatalogSnapshotSchema.parse({
      commitSha,
      skills: [
        {
          id: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0",
          commitSha,
          name: "Weather",
          description: "Answer current weather questions",
          instructions: "Use the lookup result to answer.",
          triggers: { phrases: ["current weather"], minimumConfidence: 1 },
          tools: ["lookup"],
          prohibitedActions: [],
          visibility: "public",
          ownerTelegramUserIds: ["4"],
          allowedTelegramUserIds: [],
          status: "active",
        },
      ],
    });
    const capabilities = new CapabilityRegistry([
      {
        request: {
          id: "lookup",
          description: "Lookup weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
        input: z.object({ city: z.string() }),
        execute: async () => ({ city: "Hong Kong", temperatureC: 28 }),
      },
    ]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "function_call",
                name: "lookup",
                call_id: "weather-1",
                arguments: '{"city":"Hong Kong"}',
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "Hong Kong is currently 28°C.",
          }),
        ),
      );
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      new DeepSeekProvider(
        { apiKey: "test", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
        capabilities,
      ),
      telegram,
      "Be helpful.",
      undefined,
      undefined,
      new SkillResolver(capabilities, catalog.skills),
      [],
    ).handle({
      kind: "text",
      updateId: "routing-1",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "current weather in Hong Kong",
    });
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "Hong Kong is currently 28°C.",
    );
    expect(JSON.stringify(telegram.send.mock.calls)).not.toMatch(
      /tool_calls|function_call|invoke/i,
    );
  });
});
