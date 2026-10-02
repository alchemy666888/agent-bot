import { describe, expect, it, vi } from "vitest";
import { GitHubContentsTransport } from "../../../src/server/github/contents-client";
import { GitHubPromptStore } from "../../../src/server/prompts/github-store";

const COMMIT = "a".repeat(40);
const BASE_BLOB = "b".repeat(40);
const DEFAULT_BLOB = "c".repeat(40);

function prompt(id: string, kind: "system" | "request", status = "active") {
  return `---\nschema_version: 1\nid: ${id}\nkind: ${kind}\nscope: common\nstatus: ${status}\nsummary: Safe common prompt\ntriggers:\n  commands: []\n  phrases: []\nlanguages:\n  - "*"\n---\nBe helpful and accurate.`;
}

function setup(defaultStatus = "active") {
  const files = new Map([
    [
      "prompts/common/system/base.md",
      { sha: BASE_BLOB, content: prompt("base", "system") },
    ],
    [
      "prompts/common/requests/default.md",
      {
        sha: DEFAULT_BLOB,
        content: prompt("default", "request", defaultStatus),
      },
    ],
  ]);
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/git/ref/heads/main"))
      return Response.json({ object: { type: "commit", sha: COMMIT } });
    const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    expect(url.searchParams.get("ref")).toBe(COMMIT);
    if (path === "prompts")
      return Response.json([
        {
          path: "prompts/common",
          name: "common",
          type: "dir",
          sha: "tree",
          size: 0,
        },
      ]);
    if (path === "prompts/common")
      return Response.json([
        {
          path: "prompts/common/system",
          name: "system",
          type: "dir",
          sha: "tree",
          size: 0,
        },
        {
          path: "prompts/common/requests",
          name: "requests",
          type: "dir",
          sha: "tree",
          size: 0,
        },
      ]);
    if (path.endsWith("/system") || path.endsWith("/requests")) {
      const entries = [...files.entries()].filter(([filePath]) =>
        filePath.startsWith(`${path}/`),
      );
      return Response.json(
        entries.map(([filePath, file]) => ({
          path: filePath,
          name: filePath.split("/").at(-1),
          type: "file",
          sha: file.sha,
          size: Buffer.byteLength(file.content),
        })),
      );
    }
    const file = files.get(path);
    if (!file) return new Response(null, { status: 404 });
    return Response.json({
      path,
      name: path.split("/").at(-1),
      type: "file",
      sha: file.sha,
      size: Buffer.byteLength(file.content),
      encoding: "base64",
      content: Buffer.from(file.content).toString("base64"),
    });
  });
  const transport = new GitHubContentsTransport(
    { connector: "github/test", owner: "private-owner", repository: "skill" },
    {
      fetch: fetch as typeof globalThis.fetch,
      tokenProvider: async () => "secret",
    },
  );
  return { store: new GitHubPromptStore(transport, { branch: "main" }), fetch };
}

describe("GitHubPromptStore", () => {
  it("pins hierarchy enumeration and every read to one immutable commit", async () => {
    const { store, fetch } = setup();
    const snapshot = await store.load();
    expect(snapshot.commitSha).toBe(COMMIT);
    expect(snapshot.files).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("rejects an incomplete or inactive mandatory hierarchy atomically", async () => {
    const { store } = setup("disabled");
    await expect(store.load()).rejects.toThrow("Mandatory common prompts");
  });
});
