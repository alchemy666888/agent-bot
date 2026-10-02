import { describe, expect, it } from "vitest";
import { promptDegradationNotices } from "../../../src/server/telegram/dispatch";
import type { PromptBundle } from "../../../src/shared/contracts/prompt";

const sha = "a".repeat(40);
const healthy: PromptBundle = {
  schemaVersion: 1,
  runtimePolicy: { version: "1", mode: "normal" },
  commonSystemPrompt: {
    id: "base",
    content: "System",
    source: "repository",
    blobSha: sha,
  },
  requestTemplate: {
    id: "default",
    content: "Request",
    source: "repository",
    blobSha: sha,
  },
  trustedRuntimeContext: [],
  repositoryCommitSha: sha,
  selectedBlobShas: [
    { promptId: "base", blobSha: sha },
    { promptId: "default", blobSha: sha },
  ],
  resolutionSource: "default",
  degradedModeSource: null,
  turnPin: { commitSha: sha, pinnedAt: "2026-10-02T00:00:00.000Z" },
  telemetry: { resolution: "fallback", degraded: false },
};

describe("prompt degradation notices", () => {
  it("does not warn for the ordinary repository-backed default", () => {
    expect(promptDegradationNotices(healthy, "hello")).toEqual([]);
  });

  it("reports an explicitly requested missing prompt", () => {
    expect(promptDegradationNotices(healthy, "/prompt absent")).toEqual([
      "request_prompt_missing",
    ]);
  });

  it("reports stale snapshots and compiled emergency defaults without sensitive metadata", () => {
    expect(
      promptDegradationNotices(
        {
          ...healthy,
          degradedModeSource: "verified_snapshot",
          telemetry: { resolution: "fallback", degraded: true },
        },
        "hello",
      ),
    ).toEqual(["stale_snapshot"]);
    const emergency: PromptBundle = {
      ...healthy,
      runtimePolicy: { version: "1", mode: "emergency" },
      commonSystemPrompt: {
        id: "base",
        content: "Emergency",
        source: "compiled_emergency",
      },
      requestTemplate: {
        id: "default",
        content: "Request",
        source: "compiled_emergency",
      },
      repositoryCommitSha: null,
      selectedBlobShas: [],
      resolutionSource: "emergency",
      degradedModeSource: "compiled_emergency",
      turnPin: { commitSha: null, pinnedAt: "2026-10-02T00:00:00.000Z" },
      telemetry: { resolution: "fallback", degraded: true },
    };
    expect(promptDegradationNotices(emergency, "hello")).toEqual([
      "system_prompt_missing",
      "compiled_emergency_prompt",
    ]);
  });
});
