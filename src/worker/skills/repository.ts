import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { uuidV7 } from "../../shared/ids";
import { isTelegramActorAllowed } from "../../shared/telegram-allowlist";
import { EventStore } from "../persistence/event-store";
import { statePath } from "../persistence/layout";
import { projectEvent } from "../persistence/projector";
import type { DurableEvent } from "../persistence/schemas";
import type { LockCoordinator } from "../locks/coordinator";
import { prepareSkillRevision, skillDraftDigest } from "./authoring-document";
import {
  SkillRevisionConflictError,
  type SkillDefinitionStore,
} from "./definition-store";
import type { SkillDraft } from "./types";

export { skillDraftDigest };

type Projection = SkillDraft & { revision: number };

export interface SkillAuthoringPolicy {
  /** Telegram identities provisioned by the operator, not supplied by a draft. */
  authorTelegramUserIds: ReadonlySet<string>;
  /** Public usernames, without "@" and compared case-insensitively. */
  authorTelegramUsernames?: ReadonlySet<string>;
  /** Telegram identities allowed to publish a pending revision. */
  approverTelegramUserIds?: ReadonlySet<string>;
  /** Capability IDs provisioned by the operator registry. */
  capabilityIds: ReadonlySet<string>;
}

function authorAllowed(
  policy: SkillAuthoringPolicy,
  userId: string,
  username?: string,
): boolean {
  return isTelegramActorAllowed(
    {
      ids: policy.authorTelegramUserIds,
      ...(policy.authorTelegramUsernames
        ? { usernames: policy.authorTelegramUsernames }
        : {}),
    },
    userId,
    username,
  );
}

export class DurableSkillDraftRepository {
  private readonly events: EventStore;

  constructor(
    private readonly root: string,
    private readonly locks: LockCoordinator,
    private readonly definitions: SkillDefinitionStore,
    private readonly policy: SkillAuthoringPolicy = {
      authorTelegramUserIds: new Set(),
      capabilityIds: new Set(),
    },
  ) {
    this.events = new EventStore(root);
  }

  async begin(draft: SkillDraft): Promise<SkillDraft> {
    return {
      ...draft,
      versionId: null,
      contentDigest: null,
      revisionNumber: draft.revisionNumber,
    };
  }

  async commitRevision(
    draft: SkillDraft,
    content: string,
  ): Promise<SkillDraft> {
    const prepared = prepareSkillRevision(draft, content);
    try {
      const version = await this.definitions.insertDraftVersion({
        skillId: draft.stableId,
        name: prepared.manifest.name,
        ownerTelegramUserId: draft.ownerTelegramUserId,
        visibility: prepared.manifest.visibility,
        expectedRevision: draft.revisionNumber,
        contentDigest: prepared.contentDigest,
        manifest: prepared.manifest,
        instructions: prepared.document,
        createdBy: draft.ownerTelegramUserId,
      });
      return {
        ...draft,
        draftContent: prepared.document,
        revisionNumber: version.revision,
        versionId: version.id,
        contentDigest: prepared.contentDigest,
      };
    } catch (error) {
      if (error instanceof SkillRevisionConflictError)
        throw new Error("SKILL_REVISION_REQUIRED");
      throw error;
    }
  }

  async publish(
    draft: SkillDraft,
    username?: string,
  ): Promise<{ state: "pending"; versionId: string; revision: number }> {
    if (!draft.skillName || !draft.contentDigest || !draft.versionId)
      throw new Error("SKILL_DRAFT_INCOMPLETE");
    if (!authorAllowed(this.policy, draft.ownerTelegramUserId, username))
      throw new Error("SKILL_AUTHOR_NOT_AUTHORIZED");
    if (
      draft.requiredToolsFunctions.some(
        (capability) => !this.policy.capabilityIds.has(capability),
      )
    )
      throw new Error("SKILL_CAPABILITY_NOT_REGISTERED");
    try {
      const pending = await this.definitions.markPending({
        skillId: draft.stableId,
        versionId: draft.versionId,
        expectedRevision: draft.revisionNumber,
        contentDigest: draft.contentDigest,
        actor: draft.ownerTelegramUserId,
      });
      return {
        state: "pending",
        versionId: pending.id,
        revision: pending.revision,
      };
    } catch (error) {
      if (error instanceof SkillRevisionConflictError)
        throw new Error("SKILL_REVISION_REQUIRED");
      throw error;
    }
  }

  async publishApproved(input: {
    actorTelegramUserId: string;
    skillId: string;
    revision: number;
  }): Promise<{ name: string; revision: number; versionId: string }> {
    if (!this.policy.approverTelegramUserIds?.has(input.actorTelegramUserId))
      throw new Error("SKILL_APPROVER_NOT_AUTHORIZED");
    const version = await this.definitions.getRevision(
      input.skillId,
      input.revision,
    );
    if (!version) throw new Error("SKILL_REVISION_REQUIRED");
    const grants = this.policy.capabilityIds;
    if (version.manifest.tools.some((id) => !grants.has(id)))
      throw new Error("SKILL_CAPABILITY_NOT_REGISTERED");
    try {
      const published = await this.definitions.publish({
        skillId: input.skillId,
        expectedRevision: input.revision,
        actor: input.actorTelegramUserId,
      });
      return {
        name: published.manifest.name,
        revision: published.revision,
        versionId: published.id,
      };
    } catch (error) {
      if (error instanceof SkillRevisionConflictError)
        throw new Error("SKILL_REVISION_REQUIRED");
      throw error;
    }
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
    const payload: Record<string, unknown> = { ...draft, draftContent: null };
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
