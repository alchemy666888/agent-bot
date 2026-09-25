import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { uuidV7 } from "../../shared/ids";
import type { ModelRequest } from "../../shared/contracts";
import { LockCoordinator } from "../locks/coordinator";
import { EventStore } from "../persistence/event-store";
import { projectEvent } from "../persistence/projector";
import { statePath, type RecordKind } from "../persistence/layout";
import type { DurableEvent } from "../persistence/schemas";
import type { Message, UserProfile } from "./service";

type State = Record<string, unknown> & { revision: number };

export class DurableConversationService {
  private events: EventStore;

  constructor(
    private root: string,
    private locks: LockCoordinator,
  ) {
    this.events = new EventStore(root);
  }

  async contact(input: {
    id: string;
    username?: string;
    languageCode?: string;
    at: string;
  }): Promise<UserProfile> {
    const prior = await this.read("users", input.id);
    let activeConversationId = prior?.activeConversationId as
      string | undefined;
    if (!activeConversationId) {
      const conversationId = uuidV7();
      await this.commit(
        input.id,
        "conversations",
        conversationId,
        "conversation.created",
        1,
        input.at,
        {
          id: conversationId,
          userId: input.id,
          status: "active",
          createdAt: input.at,
          updatedAt: input.at,
          archivedAt: null,
        },
      );
      activeConversationId = conversationId;
    }
    const profile: UserProfile = {
      telegramUserId: input.id,
      username:
        input.username ??
        (prior?.username as string | null | undefined) ??
        null,
      languageCode:
        input.languageCode ??
        (prior?.languageCode as string | null | undefined) ??
        null,
      firstSeenAt: (prior?.firstSeenAt as string | undefined) ?? input.at,
      lastSeenAt: input.at,
    };
    await this.commit(
      input.id,
      "users",
      input.id,
      prior ? "user.seen" : "user.created",
      (prior?.revision ?? 0) + 1,
      input.at,
      { ...profile, activeConversationId },
    );
    return profile;
  }

  async newConversation(userId: string): Promise<void> {
    const user = await this.requireUser(userId);
    const at = new Date().toISOString();
    const oldId = user.activeConversationId as string;
    const prior = await this.require("conversations", oldId);
    await this.commit(
      userId,
      "conversations",
      oldId,
      "conversation.archived",
      prior.revision + 1,
      at,
      {
        ...this.payload(prior),
        status: "archived",
        updatedAt: at,
        archivedAt: at,
      },
    );
    const id = uuidV7();
    await this.commit(
      userId,
      "conversations",
      id,
      "conversation.created",
      1,
      at,
      {
        id,
        userId,
        status: "active",
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      },
    );
    await this.commit(
      userId,
      "users",
      userId,
      "user.active_conversation_changed",
      user.revision + 1,
      at,
      {
        ...this.payload(user),
        activeConversationId: id,
      },
    );
  }

  async add(
    userId: string,
    role: Message["role"],
    text: string,
    at = new Date().toISOString(),
  ): Promise<Message> {
    const user = await this.requireUser(userId);
    const message: Message = {
      id: uuidV7(),
      conversationId: user.activeConversationId as string,
      role,
      text,
      createdAt: at,
    };
    await this.commit(
      userId,
      "messages",
      message.id,
      "message.created",
      1,
      at,
      { ...message },
    );
    return message;
  }

  async context(userId: string, systemPrompt: string): Promise<ModelRequest> {
    const user = await this.requireUser(userId);
    const conversationId = user.activeConversationId as string;
    const messages = (await this.list("messages"))
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const pairs: State[][] = [];
    for (let index = 0; index < messages.length - 1; index++) {
      if (
        messages[index]!.role === "user" &&
        messages[index + 1]!.role === "assistant"
      ) {
        pairs.push([messages[index]!, messages[index + 1]!]);
        index++;
      }
    }
    const latest = messages.at(-1);
    return {
      messages: [
        { role: "system", content: systemPrompt },
        ...pairs
          .slice(-20)
          .flat()
          .map((item) => ({
            role: item.role as "user" | "assistant",
            content: item.text as string,
          })),
        ...(latest?.role === "user"
          ? [{ role: "user" as const, content: latest.text as string }]
          : []),
      ],
    };
  }

  async message(id: string): Promise<Message | undefined> {
    const state = await this.read("messages", id);
    if (!state) return undefined;
    return {
      id: state.id as string,
      conversationId: state.conversationId as string,
      role: state.role as Message["role"],
      text: state.text as string,
      createdAt: state.createdAt as string,
    };
  }

  private async commit(
    userId: string,
    kind: RecordKind,
    entityId: string,
    type: string,
    revision: number,
    occurredAt: string,
    payload: Record<string, unknown>,
  ) {
    const event: DurableEvent = {
      schemaVersion: 1,
      eventId: uuidV7(),
      entityId,
      kind,
      type,
      occurredAt,
      revision,
      payload,
    };
    await this.locks.withMutation(async () => {
      await this.events.append(event);
      await projectEvent(this.root, event);
    }, userId);
  }

  private async read(kind: RecordKind, id: string): Promise<State | undefined> {
    try {
      return JSON.parse(
        await readFile(statePath(this.root, kind, id), "utf8"),
      ) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async require(kind: RecordKind, id: string): Promise<State> {
    const value = await this.read(kind, id);
    if (!value) throw new Error("PROJECTION_NOT_FOUND");
    return value;
  }

  private requireUser(id: string) {
    return this.require("users", id);
  }

  private payload(state: State) {
    const payload: Record<string, unknown> = { ...state };
    delete payload.schemaVersion;
    delete payload.entityId;
    delete payload.revision;
    delete payload.sourceEventId;
    return payload;
  }

  private async list(kind: RecordKind): Promise<State[]> {
    const directory = join(this.root, "data/state", kind);
    const names = await readdir(directory).catch(() => [] as string[]);
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(await readFile(join(directory, name), "utf8")) as State,
        ),
    );
  }
}
