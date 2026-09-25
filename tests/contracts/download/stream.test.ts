import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { streamWithCleanup } from "../../../src/server/export/service";

describe("download stream bridge", () => {
  it("pulls incrementally and cleans only after completion", async () => {
    const cleanup = vi.fn(async () => undefined);
    const source = Readable.from([Buffer.from("one"), Buffer.from("two")]);
    const reader = streamWithCleanup(source, cleanup).getReader();
    expect(cleanup).not.toHaveBeenCalled();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("one");
    expect(cleanup).not.toHaveBeenCalled();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("two");
    expect((await reader.read()).done).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("destroys the source and cleans once when the client disconnects", async () => {
    const cleanup = vi.fn(async () => undefined);
    const source = new Readable({ read() {} });
    const reader = streamWithCleanup(source, cleanup).getReader();
    await reader.cancel();
    expect(source.destroyed).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans failed streams without returning buffered content", async () => {
    const cleanup = vi.fn(async () => undefined);
    const source = new Readable({
      read() {
        this.destroy(new Error("transfer failed"));
      },
    });
    const reader = streamWithCleanup(source, cleanup).getReader();
    await expect(reader.read()).rejects.toThrow("transfer failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
