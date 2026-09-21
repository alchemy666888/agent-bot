import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class LockCoordinator {
  private heldUser = new Set<string>();
  constructor(
    private root: string,
    private staleMs = 30_000,
  ) {}
  async withUser<T>(userId: string, action: () => Promise<T>): Promise<T> {
    return this.acquire(`users/${userId}`, async () => {
      this.heldUser.add(userId);
      try {
        return await action();
      } finally {
        this.heldUser.delete(userId);
      }
    });
  }
  async withMutation<T>(action: () => Promise<T>, userId?: string): Promise<T> {
    if (userId && !this.heldUser.has(userId))
      throw new Error("LOCK_ORDER_VIOLATION");
    return this.acquire("mutation", action);
  }
  async withExport<T>(action: () => Promise<T>): Promise<T> {
    return this.acquire("mutation", action);
  }
  private async acquire<T>(name: string, action: () => Promise<T>): Promise<T> {
    const path = join(this.root, "runtime/locks", `${name}.lock`);
    await mkdir(dirname(path), { recursive: true });
    const owner = randomUUID();
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(path, { recursive: false });
        await writeFile(
          join(path, "owner.json"),
          JSON.stringify({ owner, heartbeat: Date.now() }),
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let prior: { heartbeat: number };
        try {
          prior = JSON.parse(
            await readFile(join(path, "owner.json"), "utf8"),
          ) as { heartbeat: number };
        } catch {
          prior = { heartbeat: Date.now() };
        }
        if (Date.now() - prior.heartbeat > this.staleMs) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("LOCK_TIMEOUT");
        await sleep(5);
      }
    }
    try {
      return await action();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
}
