import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { uuidV7 } from "../../shared/ids";
import { EventStore } from "../persistence/event-store";
import { statePath } from "../persistence/layout";
import { projectEvent } from "../persistence/projector";
import type { DurableEvent } from "../persistence/schemas";
import type { LockCoordinator } from "../locks/coordinator";
import type { SkillDraft } from "./types";

type Projection = SkillDraft & { revision: number };

export class DurableSkillDraftRepository {
  private readonly events: EventStore;

  constructor(
    private readonly root: string,
    private readonly locks: LockCoordinator,
  ) {
    this.events = new EventStore(root);
  }

  async activeForOwner(
    ownerTelegramUserId: string,
  ): Promise<Projection | undefined> {
    return (await this.forOwner(ownerTelegramUserId)).find(
      (draft) => !["installed", "cancelled"].includes(draft.status),
    );
  }

  async processedUpdate(
    ownerTelegramUserId: string,
    updateId: string,
  ): Promise<Projection | undefined> {
    return (await this.forOwner(ownerTelegramUserId)).find(
      (draft) => draft.lastProcessedUpdateId === updateId,
    );
  }

  private async forOwner(ownerTelegramUserId: string): Promise<Projection[]> {
    const directory = dirname(statePath(this.root, "skill-drafts", "x"));
    const names = await readdir(directory).catch(() => [] as string[]);
    const drafts = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(
              await readFile(join(directory, name), "utf8"),
            ) as Projection,
        ),
    );
    return drafts
      .filter((draft) => draft.ownerTelegramUserId === ownerTelegramUserId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Projection | undefined> {
    try {
      return JSON.parse(
        await readFile(statePath(this.root, "skill-drafts", id), "utf8"),
      ) as Projection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(draft: SkillDraft, type: string): Promise<Projection> {
    const prior = await this.get(draft.id);
    const payload: Record<string, unknown> = { ...draft };
    // Projection metadata is never aggregate data and must not overwrite the
    // new event's monotonically increasing revision/source identifiers.
    delete payload.schemaVersion;
    delete payload.entityId;
    delete payload.revision;
    delete payload.sourceEventId;
    const event: DurableEvent = {
      schemaVersion: 1,
      eventId: uuidV7(),
      entityId: draft.id,
      kind: "skill-drafts",
      type,
      occurredAt: draft.updatedAt,
      revision: (prior?.revision ?? 0) + 1,
      payload,
    };
    await this.locks.withMutation(async () => {
      await this.events.append(event);
      await projectEvent(this.root, event);
    }, draft.ownerTelegramUserId);
    return { ...(payload as unknown as SkillDraft), revision: event.revision };
  }
}
