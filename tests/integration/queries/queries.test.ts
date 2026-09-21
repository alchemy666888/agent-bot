import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QueryService } from "../../../src/worker/queries/service";
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("read-only queries", () => {
  it("searches and paginates deterministically without mutation", async () => {
    root = await mkdtemp(join(tmpdir(), "query-"));
    const dir = join(root, "data/state/users");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 75; i++)
      await writeFile(
        join(dir, `${i}.json`),
        JSON.stringify({
          telegramUserId: String(i),
          username: i === 42 ? "Needle" : null,
        }),
      );
    const before = await readdir(dir);
    const service = new QueryService(root);
    expect((await service.list("users", { page: 1 })).items).toHaveLength(50);
    expect((await service.list("users", { search: "needle" })).total).toBe(1);
    expect(await readdir(dir)).toEqual(before);
  });
  it("rejects malformed pages and returns empty beyond range", async () => {
    root = await mkdtemp(join(tmpdir(), "query-"));
    const service = new QueryService(root);
    await expect(service.list("users", { page: 0 })).rejects.toThrow();
    expect((await service.list("users", { page: 9 })).items).toEqual([]);
  });
});
