import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("pg", () => ({
  Pool: vi.fn(function Pool() {
    return { query };
  }),
}));

import { createPostgresStore } from "../../../../src/shared/postgres/client";

const path = "logs/controller/webhook-ack-2.json";

describe("postgres file claim", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("inserts a path once and does not overwrite an existing record", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ path }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const store = createPostgresStore("postgres://localhost/telegram");
    const body = Buffer.from('{"updateId":"2"}');

    await expect(store.claim(path, body)).resolves.toBe(true);
    await expect(store.claim(path, body)).resolves.toBe(false);

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ON CONFLICT (path) DO NOTHING RETURNING path"),
      [path, body],
    );
    expect(String(query.mock.calls[1]?.[0])).not.toContain("DO UPDATE");
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("ON CONFLICT (path) DO NOTHING"),
      [path, body],
    );
  });

  it("rejects a path outside the persistence root before writing", async () => {
    const store = createPostgresStore("postgres://localhost/telegram");
    await expect(
      store.claim("../secret.json", Buffer.from("x")),
    ).rejects.toThrow("PERSISTENCE_PATH_REJECTED");
    expect(query).not.toHaveBeenCalled();
  });
});
