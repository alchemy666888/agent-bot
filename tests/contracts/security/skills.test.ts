import { describe, expect, it, vi } from "vitest";
import { readGitHubConfig } from "../../../src/server/config";
import {
  GitHubSkillsClient,
  GitHubSkillsError,
  validateSkillPath,
} from "../../../src/server/github/skills-client";

const config = {
  connector: "github/catalog",
  owner: "owner",
  repository: "repo",
  branch: "main",
};
const file = (content: string, overrides: Record<string, unknown> = {}) =>
  Response.json({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
    size: Buffer.byteLength(content),
    sha: "blob",
    path: "skills/a/SKILL.md",
    name: "SKILL.md",
    ...overrides,
  });

describe("GitHub skills client security contract", () => {
  it("rejects missing and invalid connector configuration", () => {
    expect(() => readGitHubConfig({})).toThrow();
    expect(() =>
      readGitHubConfig({
        GITHUB_CONNECTOR: "token",
        GITHUB_SKILLS_OWNER: "o",
        GITHUB_SKILLS_REPO: "r",
        GITHUB_SKILLS_BRANCH: "main",
      }),
    ).toThrow();
  });

  it("acquires a fresh app-scoped token and never persists it", async () => {
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two");
    const fetch = vi.fn(async (_url, init?: RequestInit) => {
      expect(String(new Headers(init?.headers).get("authorization"))).toMatch(
        /^Bearer (one|two)$/,
      );
      return file("ok");
    });
    const client = new GitHubSkillsClient(config, {
      tokenProvider,
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.readFile("skills/a/SKILL.md", "main");
    await client.readFile("skills/a/SKILL.md", "main");
    expect(tokenProvider).toHaveBeenNthCalledWith(1, "github/catalog", {
      subject: { type: "app" },
    });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(client)).not.toMatch(/one|two/);
  });

  it.each([
    "../x.md",
    "skills/../x.md",
    "skills/%2e%2e/x.md",
    "skills/a\\x.md",
    "skills/a.exe",
    "other/a.md",
  ])("rejects unsafe path %s", (path) => {
    expect(() => validateSkillPath(path)).toThrow(TypeError);
  });

  it("enforces declared and decoded response size limits and strict base64 responses", async () => {
    for (const response of [
      file("abcd", { size: 99 }),
      file("abcd", { content: "%%%", size: 0 }),
      file("abcd", { encoding: "utf8" }),
    ]) {
      const client = new GitHubSkillsClient(config, {
        maxFileBytes: 4,
        tokenProvider: async () => "token",
        fetch: vi.fn(async () => response.clone()),
      });
      await expect(
        client.readFile("skills/a/SKILL.md", "main"),
      ).rejects.toMatchObject({ kind: "invalid_response" });
    }
    const client = new GitHubSkillsClient(config, {
      maxFileBytes: 3,
      tokenProvider: async () => "token",
      fetch: vi.fn(async () => file("abcd")),
    });
    await expect(
      client.putFile({
        path: "skills/a/SKILL.md",
        branch: "main",
        content: "abcd",
        message: "write",
        expectedSha: null,
      }),
    ).rejects.toThrow("upload byte limit");
  });

  it("classifies rate limits and retries safe reads only", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(file("ok"));
    const client = new GitHubSkillsClient(config, {
      tokenProvider: async () => "token",
      fetch,
      sleep,
      maxReadRetries: 1,
    });
    expect((await client.readFile("skills/a/SKILL.md", "main")).content).toBe(
      "ok",
    );
    expect(sleep).toHaveBeenCalledWith(1000);
    const write = new GitHubSkillsClient(config, {
      tokenProvider: async () => "token",
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      maxReadRetries: 2,
    });
    await expect(
      write.putFile({
        path: "skills/a/SKILL.md",
        branch: "main",
        content: "x",
        message: "x",
        expectedSha: "old",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitHubSkillsError>>({
        kind: "transient",
        retryable: true,
      }),
    );
  });
});
