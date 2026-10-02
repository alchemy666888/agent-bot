import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("prompt GitHub trust boundary", () => {
  it("keeps repository credentials and transport out of the sandbox", async () => {
    const transport = await readFile(
      "src/server/github/contents-client.ts",
      "utf8",
    );
    const promptStore = await readFile(
      "src/server/prompts/github-store.ts",
      "utf8",
    );
    const sandbox = await readFile("src/server/sandbox/transport.ts", "utf8");

    expect(transport).toContain('import "server-only"');
    expect(promptStore).toContain('import "server-only"');
    expect(promptStore).toContain("normalizePromptPath");
    expect(sandbox).not.toMatch(/GITHUB_|github\/|Authorization.*Bearer/i);
  });

  it("owns the prompts prefix restriction in the trusted prompt store", async () => {
    const promptStore = await readFile(
      "src/server/prompts/github-store.ts",
      "utf8",
    );
    expect(promptStore).toContain('this.prefix !== "prompts"');
    expect(promptStore).toContain("Path is outside configured prompt prefix");
    expect(promptStore).toContain("Links and submodules are prohibited");
  });
});
