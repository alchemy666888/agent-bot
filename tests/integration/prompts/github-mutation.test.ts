import { describe, expect, it, vi } from "vitest";
import type { GitHubContentsTransport } from "../../../src/server/github/contents-client";
import { GitHubPromptStore } from "../../../src/server/prompts/github-store";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const path = "prompts/common/requests/default.md";
const basePath = "prompts/common/system/base.md";
export const prompt = (id: string, kind: "system" | "request", body: string) =>
  `---\nschema_version: 1\nid: ${id}\nkind: ${kind}\nscope: common\nstatus: active\nsummary: Safe prompt\ntriggers:\n  commands: []\n  phrases: []\nlanguages:\n  - "*"\n---\n${body}`;

export function fakeTransport() {
  let head = B; // main advanced from proposal A, but not in the target file
  const files = new Map([
    [
      basePath,
      {
        sha: C,
        bytes: new TextEncoder().encode(prompt("base", "system", "Base")),
      },
    ],
    [
      path,
      {
        sha: D,
        bytes: new TextEncoder().encode(prompt("default", "request", "Old")),
      },
    ],
  ]);
  const transport = {
    resolveBranch: vi.fn(async () => head),
    list: vi.fn(async (directory: string) => {
      if (directory === "prompts")
        return [
          {
            path: "prompts/common",
            name: "common",
            type: "dir",
            sha: C,
            size: 0,
          },
        ];
      if (directory === "prompts/common")
        return ["system", "requests"].map((name) => ({
          path: `prompts/common/${name}`,
          name,
          type: "dir",
          sha: C,
          size: 0,
        }));
      return [...files]
        .filter(([name]) => name.startsWith(`${directory}/`))
        .map(([name, file]) => ({
          path: name,
          name: name.split("/").at(-1)!,
          type: "file",
          sha: file.sha,
          size: file.bytes.length,
        }));
    }),
    read: vi.fn(async (name: string) => {
      const file = files.get(name);
      if (!file) throw new Error("not found");
      return {
        path: name,
        name: name.split("/").at(-1)!,
        type: "file",
        size: file.bytes.length,
        ...file,
      };
    }),
    mutate: vi.fn(
      async (input: { expectedBranchSha: string; content?: string }) => {
        expect(input.expectedBranchSha).toBe(B);
        files.set(path, {
          sha: E,
          bytes: new TextEncoder().encode(input.content!),
        });
        head = E;
        return { commit: { sha: E }, content: { sha: E } };
      },
    ),
  };
  return {
    transport,
    files,
    setHead: (sha: string) => {
      head = sha;
    },
  };
}

describe("verified GitHub prompt mutation", () => {
  it("rebases an unchanged target onto the latest main and validates read-back", async () => {
    const fake = fakeTransport();
    const store = new GitHubPromptStore(
      fake.transport as unknown as GitHubContentsTransport,
      { branch: "main" },
    );
    const content = prompt("default", "request", "New");
    const result = await store.mutate({
      path,
      content,
      message: "update prompt",
      expectedBranchSha: A,
      expectedBlobSha: D,
    });
    expect(result.commit.sha).toBe(E);
    expect(result.snapshot.commitSha).toBe(E);
    expect(fake.transport.mutate).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(fake.files.get(path)!.bytes)).toBe(content);
  });
});
