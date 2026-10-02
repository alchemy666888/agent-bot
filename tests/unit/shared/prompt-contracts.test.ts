import { describe, expect, it } from "vitest";
import {
  parseAuthorizedPromptRoutingResult,
  promptBundleSchema,
  promptChangeProposalResultSchema,
  promptMetadataSchema,
  promptRoutingRequestSchema,
} from "../../../src/shared/contracts";

const sha = "a".repeat(40);
const blob = "b".repeat(40);

function bundle() {
  return {
    schemaVersion: 1,
    runtimePolicy: { version: "1", mode: "normal" },
    commonSystemPrompt: {
      id: "base",
      content: "Be helpful.",
      source: "repository",
      blobSha: blob,
    },
    requestTemplate: {
      id: "default",
      content: "Answer the request.",
      source: "repository",
      blobSha: sha,
    },
    trustedRuntimeContext: [{ key: "locale", value: "en" }],
    repositoryCommitSha: sha,
    selectedBlobShas: [
      { promptId: "base", blobSha: blob },
      { promptId: "default", blobSha: sha },
    ],
    resolutionSource: "default",
    degradedModeSource: null,
    turnPin: { commitSha: sha, pinnedAt: "2026-10-02T00:00:00.000Z" },
    telemetry: { resolution: "fallback", degraded: false },
  } as const;
}

describe("prompt contracts", () => {
  it("accepts a strict, commit-pinned bundle", () => {
    expect(promptBundleSchema.parse(bundle()).repositoryCommitSha).toBe(sha);
  });

  it("rejects unknown and identity-shaped properties", () => {
    expect(() =>
      promptBundleSchema.parse({ ...bundle(), telegramUserId: "123" }),
    ).toThrow();
    expect(() =>
      promptChangeProposalResultSchema.parse({
        proposalId: "019a3c57-b3bd-7000-8000-000000000000",
        status: "pending_confirmation",
        expiresAt: "2026-10-02T00:10:00.000Z",
        summary: "Use concise answers",
        repositoryPath: "prompts/users/123/system.md",
      }),
    ).toThrow();
  });

  it("rejects malformed SHAs, oversized layers, and duplicate prompt IDs", () => {
    expect(() =>
      promptBundleSchema.parse({ ...bundle(), repositoryCommitSha: "abc" }),
    ).toThrow();
    const oversized = bundle();
    expect(() =>
      promptBundleSchema.parse({
        ...oversized,
        commonSystemPrompt: {
          ...oversized.commonSystemPrompt,
          content: "é".repeat(9_000),
        },
      }),
    ).toThrow();
    expect(() =>
      promptBundleSchema.parse({
        ...bundle(),
        selectedBlobShas: [
          { promptId: "base", blobSha: blob },
          { promptId: "base", blobSha: sha },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate routing candidates and unauthorized selected IDs", () => {
    const request = {
      requestId: "019a3c57-b3bd-7000-8000-000000000000",
      candidates: [
        {
          id: "research",
          kind: "request",
          scope: "global",
          summary: "Research",
          commands: [],
          phrases: [],
        },
      ],
    } as const;
    expect(promptRoutingRequestSchema.parse(request)).toBeTruthy();
    expect(() =>
      promptRoutingRequestSchema.parse({
        ...request,
        candidates: [request.candidates[0], request.candidates[0]],
      }),
    ).toThrow();
    expect(() =>
      parseAuthorizedPromptRoutingResult(request, {
        requestId: request.requestId,
        selectedId: "not-authorized",
        confidence: 0.99,
        reasonCode: "selected",
      }),
    ).toThrow(/unauthorized/);
  });

  it("strictly validates metadata without secret-shaped fields", () => {
    const metadata = {
      schemaVersion: 1,
      id: "research",
      kind: "request",
      scope: "global",
      status: "active",
      summary: "Research",
      triggers: { commands: [], phrases: [] },
      languages: ["*"],
    } as const;
    expect(promptMetadataSchema.parse(metadata)).toBeTruthy();
    expect(() =>
      promptMetadataSchema.parse({ ...metadata, githubToken: "secret" }),
    ).toThrow();
  });
});
