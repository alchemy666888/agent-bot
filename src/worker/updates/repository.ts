import { readFile } from "node:fs/promises";
import { atomicJson } from "../persistence/atomic-json";
import { join } from "node:path";
import {
  advanceUpdate,
  updateStateSchema,
  type UpdateState,
} from "./state-machine";
export class UpdateRepository {
  constructor(private root: string) {}
  private path(id: string) {
    return join(this.root, "data/state/updates", `${id}.json`);
  }
  async get(id: string): Promise<UpdateState | undefined> {
    try {
      return updateStateSchema.parse(
        JSON.parse(await readFile(this.path(id), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async save(next: UpdateState): Promise<UpdateState> {
    const prior = await this.get(next.updateId);
    const value = prior
      ? advanceUpdate(prior, next)
      : updateStateSchema.parse(next);
    await atomicJson(this.path(next.updateId), value);
    return value;
  }
}
