import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { recordPath } from "./layout";
import { eventSchema, type DurableEvent } from "./schemas";

export class EventStore {
  constructor(private readonly root: string) {}
  async append(input: DurableEvent): Promise<string> {
    const event = eventSchema.parse(input);
    const path = recordPath(this.root, event.kind, new Date(event.occurredAt));
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "a", 0o600);
    try {
      await file.write(`${JSON.stringify(event)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return path;
  }
}
