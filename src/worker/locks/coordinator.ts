import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class LockCoordinator {
  private heldUser = new Set<string>();
  constructor(
    private root: string,
    private staleMs = 30_000,
    private timeoutMs = 5_000,
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
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      try {
        await mkdir(path, { recursive: false });
        await writeFile(
          join(path, "owner.json"),
          JSON.stringify({ owner, pid: process.pid, heartbeat: Date.now() }),
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let prior: { heartbeat: number; pid?: number };
        try {
          prior = JSON.parse(
            await readFile(join(path, "owner.json"), "utf8"),
          ) as { heartbeat: number };
        } catch {
          prior = { heartbeat: Date.now() };
        }
        if (
          Date.now() - prior.heartbeat > this.staleMs &&
          !isAlive(prior.pid)
        ) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("LOCK_TIMEOUT");
        await sleep(5);
      }
    }
    const heartbeat = setInterval(
      () =>
        void writeFile(
          join(path, "owner.json"),
          JSON.stringify({ owner, pid: process.pid, heartbeat: Date.now() }),
        ),
      Math.max(10, this.staleMs / 3),
    );
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
      await rm(path, { recursive: true, force: true });
    }
  }
}

function isAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
