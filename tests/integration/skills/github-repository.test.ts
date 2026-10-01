import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubSkillRepository } from "../../../src/server/github/skill-repository";
import {
  GitHubSkillsClient,
  GitHubSkillsError,
} from "../../../src/server/github/skills-client";

const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const SKILL_ID = randomUUID();
const tokenProvider = vi.fn(async () => "installation-token");

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: SKILL_ID,
    name: "Weather",
    description: "Forecasts",
    revision: 1,
    visibility: "private",
    ownerTelegramUserIds: ["123"],
    allowedTelegramUserIds: [],
    triggers: { phrases: [], keywords: ["weather"], minimumConfidence: 0.8 },
    tools: ["weather.lookup"],
    prohibitedActions: [],
    status: "active",
    ...overrides,
  };
}

type StoredFile = { content: string; sha: string };

function githubMock(options: { malformedManifest?: boolean } = {}) {
  let head = FIRST;
  let rejectWrites = false;
  let writes = 0;
  const files = new Map<string, Map<string, StoredFile>>();
  const seed = (ref: string, revision: number) => {
    files.set(
      ref,
      new Map([
        [
          "skills/index.json",
          {
            content: JSON.stringify({
              schemaVersion: 1,
              skills: [{ id: SKILL_ID, directory: "weather" }],
            }),
            sha: `index-${revision}`,
          },
        ],
        [
          "skills/weather/manifest.json",
          {
            content:
              options.malformedManifest && revision === 1
                ? "{}"
                : JSON.stringify(manifest({ revision })),
            sha: `manifest-${revision}`,
          },
        ],
        [
          "skills/weather/SKILL.md",
          { content: `# Weather v${revision}`, sha: `skill-${revision}` },
        ],
      ]),
    );
  };
  seed(FIRST, 1);
  seed(SECOND, 2);
  files.set("main", new Map(files.get(FIRST)!));

  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer installation-token" }),
      );
      if (url.pathname.includes("/git/ref/heads/"))
        return Response.json({ object: { sha: head, type: "commit" } });
      const marker = "/contents/";
      if (!url.pathname.includes(marker))
        return new Response(null, { status: 404 });
      const path = decodeURIComponent(url.pathname.split(marker)[1]!);
      const ref = url.searchParams.get("ref") ?? "main";
      if ((init?.method ?? "GET") === "PUT") {
        if (rejectWrites) return new Response(null, { status: 409 });
        const body = JSON.parse(String(init?.body)) as {
          branch: string;
          content: string;
          sha?: string;
        };
        const branchFiles = files.get(body.branch)!;
        const prior = branchFiles.get(path);
        if (body.sha && body.sha !== prior?.sha)
          return new Response(null, { status: 409 });
        writes += 1;
        const next = {
          content: Buffer.from(body.content, "base64").toString("utf8"),
          sha: `write-${writes}`,
        };
        branchFiles.set(path, next);
        const commitSha = String(writes + 2).repeat(40);
        head = commitSha;
        files.set(commitSha, new Map(branchFiles));
        return Response.json({
          content: { path, sha: next.sha },
          commit: { sha: commitSha },
        });
      }
      const file = files.get(ref)?.get(path);
      if (!file) return new Response(null, { status: 404 });
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(file.content).toString("base64"),
        size: Buffer.byteLength(file.content),
        sha: file.sha,
        path,
        name: path.split("/").at(-1),
      });
    },
  );

  return {
    fetch,
    setHead(value: string) {
      head = value;
      files.set("main", new Map(files.get(value)!));
    },
    rejectWrites() {
      rejectWrites = true;
    },
    get writes() {
      return writes;
    },
  };
}

function repository(mock: ReturnType<typeof githubMock>) {
  const client = new GitHubSkillsClient(
    {
      connector: "github/test",
      owner: "owner",
      repository: "catalog",
      branch: "main",
    },
    { fetch: mock.fetch as typeof fetch, tokenProvider, maxReadRetries: 0 },
  );
  return new GitHubSkillRepository(client);
}

describe("GitHubSkillRepository contract", () => {
  beforeEach(() => tokenProvider.mockClear());

  it("loads repeated and concurrent reads idempotently", async () => {
    const repo = repository(githubMock());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.getById(SKILL_ID)),
    );
    expect(results).toEqual(Array(5).fill(results[0]));
    expect((await repo.getById(SKILL_ID))?.commitSha).toBe(FIRST);
  });

  it("filters active catalog entries by ownership", async () => {
    const repo = repository(githubMock());
    expect(await repo.listAvailableToTelegramUser("999")).toEqual([]);
    expect(await repo.listAvailableToTelegramUser("123")).toEqual([
      expect.objectContaining({ id: SKILL_ID, name: "Weather" }),
    ]);
  });

  it("pins immutable versions even after the default branch advances", async () => {
    const mock = githubMock();
    const repo = repository(mock);
    const oldVersion = await repo.getById(SKILL_ID, FIRST);
    mock.setHead(SECOND);
    const current = await repo.getById(SKILL_ID);
    expect(oldVersion).toEqual(
      expect.objectContaining({ commitSha: FIRST, manifestRevision: 1 }),
    );
    expect(current).toEqual(
      expect.objectContaining({ commitSha: SECOND, manifestRevision: 2 }),
    );
    expect(await repo.getById(SKILL_ID, FIRST)).toEqual(oldVersion);
  });

  it("surfaces optimistic write conflicts without retrying", async () => {
    const mock = githubMock();
    mock.rejectWrites();
    await expect(
      repository(mock).retire({
        skillId: SKILL_ID,
        branch: "main",
        actorTelegramUserId: "123",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitHubSkillsError>>({
        kind: "conflict",
        retryable: false,
      }),
    );
    expect(mock.writes).toBe(0);
  });

  it("retires an owned skill and excludes the retired document", async () => {
    const mock = githubMock();
    const repo = repository(mock);
    await repo.retire({
      skillId: SKILL_ID,
      branch: "main",
      actorTelegramUserId: "123",
    });
    expect(mock.writes).toBe(1);
    expect(await repo.listAvailableToTelegramUser("123", "main")).toEqual([]);
  });

  it("rejects malformed repository documents", async () => {
    await expect(
      repository(githubMock({ malformedManifest: true })).getById(SKILL_ID),
    ).rejects.toThrow();
  });
});
