import { uuidV7 } from "../../shared/ids";
import { safeError } from "../../shared/logger";
import { LockCoordinator } from "../locks/coordinator";
import { EventStore } from "../persistence/event-store";
import { projectEvent } from "../persistence/projector";
import type { DurableEvent } from "../persistence/schemas";

export class DurableErrorService {
  private readonly events: EventStore;

  constructor(
    private readonly root: string,
    private readonly locks: LockCoordinator,
  ) {
    this.events = new EventStore(root);
  }

  async record(input: {
    correlationId: string;
    stage: string;
    error: unknown;
    updateId?: string;
    userId?: string;
    occurredAt?: string;
  }): Promise<string> {
    const id = uuidV7();
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const event: DurableEvent = {
      schemaVersion: 1,
      eventId: uuidV7(),
      entityId: id,
      kind: "errors",
      type: "operation.failed",
      occurredAt,
      revision: 1,
      payload: {
        id,
        correlationId: input.correlationId,
        stage: input.stage,
        occurredAt,
        ...(input.updateId ? { updateId: input.updateId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
      },
      error: safeError(input.error),
    };
    await this.locks.withMutation(async () => {
      await this.events.append(event);
      await projectEvent(this.root, event);
    }, input.userId);
    return id;
  }
}
