import { describe, expect, it } from "vitest";
import type { GitHubContentsTransport } from "../../../src/server/github/contents-client";
import {
  GitHubPromptStore,
  PromptMutationConflict,
} from "../../../src/server/prompts/github-store";
import { fakeTransport, prompt } from "./github-mutation.test";

const A = "a".repeat(40);
const path = "prompts/common/requests/default.md";

describe("GitHub prompt concurrency", () => {
  it("never overwrites a target changed since the proposal", async () => {
    const fake = fakeTransport();
    fake.files.get(path)!.sha = "f".repeat(40);
    const store = new GitHubPromptStore(
      fake.transport as unknown as GitHubContentsTransport,
      { branch: "main" },
    );
    await expect(
      store.mutate({
        path,
        content: prompt("default", "request", "Candidate"),
        message: "update",
        expectedBranchSha: A,
        expectedBlobSha: "d".repeat(40),
      }),
    ).rejects.toBeInstanceOf(PromptMutationConflict);
    expect(fake.transport.mutate).not.toHaveBeenCalled();
  });
});
