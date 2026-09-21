import { atomicJson } from "./atomic-json";
import { statePath, type RecordKind } from "./layout";
import type { DurableEvent } from "./schemas";

export async function projectEvent(
  root: string,
  event: DurableEvent,
): Promise<void> {
  await atomicJson(statePath(root, event.kind as RecordKind, event.entityId), {
    schemaVersion: 1,
    entityId: event.entityId,
    revision: event.revision,
    sourceEventId: event.eventId,
    ...event.payload,
  });
}
