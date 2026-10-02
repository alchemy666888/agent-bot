import "server-only";

import { createHash } from "node:crypto";
import {
  GitHubContentsError,
  GitHubContentsTransport,
  type GitHubContentsEntry,
} from "../github/contents-client";
import {
  normalizePromptPath,
  validatePromptSnapshot,
  type ValidatedPromptFile,
} from "./schema";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const BLOB_SHA = /^[0-9a-f]{40}$/;
const MAX_HEAD_RETRIES = 3;

export class PromptMutationConflict extends Error {
  readonly code = "PROMPT_MUTATION_CONFLICT";
  constructor() {
    // Deliberately does not disclose the path, current blob, or winning content.
    super(
      "The prompt update conflicted with another change. Please propose it again.",
    );
  }
}

export type StoredPromptFile = ValidatedPromptFile & {
  blobSha: string;
  etag?: string;
};

export type VerifiedPromptSnapshot = {
  commitSha: string;
  files: StoredPromptFile[];
  contentDigest: string;
  validatedAt: string;
};

export interface PromptStoreTelemetry {
  event: "refresh_succeeded" | "refresh_rejected" | "mutation_succeeded";
  commitSha?: string;
  fileCount?: number;
  durationMs: number;
  reasonCode?: string;
}

function safePath(path: string, prefix: string, directory = false) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    /[\0-\x1f\x7f]/.test(path)
  )
    throw new TypeError("Unsafe prompt repository path");
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.join("/") !== path
  )
    throw new TypeError("Unsafe prompt repository path");
  if (path !== prefix && !path.startsWith(`${prefix}/`))
    throw new TypeError("Path is outside configured prompt prefix");
  if (!directory) normalizePromptPath(path);
  return path;
}

function assertExpectedFile(path: string, prefix: string) {
  const relative = path.slice(prefix.length + 1);
  if (relative === "schema/prompt.schema.json") return "schema" as const;
  if (
    /^(?:common|global)\/(?:system|requests)\/[a-z][a-z0-9-]{0,63}\.md$/.test(
      relative,
    ) ||
    /^users\/u1_[A-Za-z0-9_-]{43}\/(?:system|requests)\/[a-z][a-z0-9-]{0,63}\.md$/.test(
      relative,
    )
  )
    return "prompt" as const;
  throw new TypeError("Unexpected path in prompt hierarchy");
}

function assertExpectedDirectory(path: string, prefix: string) {
  const relative = path === prefix ? "" : path.slice(prefix.length + 1);
  if (
    relative === "" ||
    /^(?:schema|common|global|users)$/.test(relative) ||
    /^(?:common|global)\/(?:system|requests)$/.test(relative) ||
    /^users\/u1_[A-Za-z0-9_-]{43}(?:\/(?:system|requests))?$/.test(relative)
  )
    return;
  throw new TypeError("Unexpected directory in prompt hierarchy");
}

/** Trusted-server prompt repository. It is the sole owner of prompt path policy. */
export class GitHubPromptStore {
  readonly prefix: string;

  constructor(
    private readonly transport: GitHubContentsTransport,
    private readonly config: { branch: string; prefix?: string },
    private readonly telemetry: (event: PromptStoreTelemetry) => void = () =>
      undefined,
  ) {
    this.prefix = config.prefix ?? "prompts";
    if (this.prefix !== "prompts")
      throw new TypeError("Prompt repository access is restricted to prompts/");
  }

  resolveHead() {
    return this.transport.resolveBranch(this.config.branch);
  }

  private async enumerate(commitSha: string): Promise<GitHubContentsEntry[]> {
    if (!COMMIT_SHA.test(commitSha))
      throw new TypeError("Invalid immutable commit SHA");
    const files: GitHubContentsEntry[] = [];
    const pending = [this.prefix];
    while (pending.length) {
      const directory = pending.pop()!;
      safePath(directory, this.prefix, true);
      assertExpectedDirectory(directory, this.prefix);
      for (const entry of await this.transport.list(directory, commitSha)) {
        safePath(entry.path, this.prefix, entry.type === "dir");
        if (entry.type === "symlink" || entry.type === "submodule")
          throw new TypeError("Links and submodules are prohibited");
        if (entry.type === "dir") {
          assertExpectedDirectory(entry.path, this.prefix);
          pending.push(entry.path);
        } else {
          assertExpectedFile(entry.path, this.prefix);
          files.push(entry);
        }
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async load(commitSha?: string): Promise<VerifiedPromptSnapshot> {
    const started = Date.now();
    const pinned = commitSha ?? (await this.resolveHead());
    try {
      const entries = await this.enumerate(pinned);
      const promptEntries = entries.filter(
        (entry) => assertExpectedFile(entry.path, this.prefix) === "prompt",
      );
      const read = await Promise.all(
        promptEntries.map(async (entry) => {
          if (!BLOB_SHA.test(entry.sha))
            throw new TypeError("Invalid blob SHA");
          const file = await this.transport.read(entry.path, pinned);
          if (!file || file.sha !== entry.sha)
            throw new TypeError("Inconsistent GitHub file metadata");
          return {
            path: entry.path,
            content: file.bytes,
            type: "file" as const,
            blobSha: file.sha,
            etag: file.etag,
          };
        }),
      );
      const validated = validatePromptSnapshot(read);
      const files = validated.map((file, index) => ({
        ...file,
        blobSha: read[index].blobSha,
        etag: read[index].etag,
      }));
      const mandatory = [
        files.find(
          (file) => file.path === `${this.prefix}/common/system/base.md`,
        ),
        files.find(
          (file) => file.path === `${this.prefix}/common/requests/default.md`,
        ),
      ];
      if (mandatory.some((file) => !file || file.metadata.status !== "active"))
        throw new TypeError("Mandatory common prompts are missing or inactive");
      const contentDigest = createHash("sha256")
        .update(
          JSON.stringify(
            files.map(({ path, metadata, body, blobSha }) => ({
              path,
              metadata,
              body,
              blobSha,
            })),
          ),
        )
        .digest("hex");
      const snapshot = {
        commitSha: pinned,
        files,
        contentDigest,
        validatedAt: new Date().toISOString(),
      };
      this.telemetry({
        event: "refresh_succeeded",
        commitSha: pinned,
        fileCount: files.length,
        durationMs: Date.now() - started,
      });
      return snapshot;
    } catch (error) {
      this.telemetry({
        event: "refresh_rejected",
        commitSha: pinned,
        durationMs: Date.now() - started,
        reasonCode: "CANDIDATE_REJECTED",
      });
      throw error;
    }
  }

  async mutate(input: {
    path: string;
    expectedBranchSha: string;
    expectedBlobSha: string | null;
    content?: string;
    message: string;
  }) {
    const started = Date.now();
    const path = safePath(input.path, this.prefix);
    if (assertExpectedFile(path, this.prefix) !== "prompt")
      throw new TypeError("Only prompt files may be mutated");
    if (input.content !== undefined)
      validatePromptSnapshot([{ path, content: input.content, type: "file" }]);
    const desired =
      input.content === undefined
        ? null
        : new TextEncoder().encode(input.content);
    let expectedHead = input.expectedBranchSha;

    for (let attempt = 0; attempt < MAX_HEAD_RETRIES; attempt++) {
      const head = await this.resolveHead();
      const current = await this.readOptional(path, head);
      const currentBlob = current?.sha ?? null;

      // The proposal is bound to the observed target version. A branch-only
      // advance is harmless; a target advance requires a brand-new proposal.
      if (currentBlob !== input.expectedBlobSha)
        throw new PromptMutationConflict();
      expectedHead = head;

      try {
        const result = await this.transport.mutate({
          ...input,
          path,
          expectedBranchSha: expectedHead,
          branch: this.config.branch,
        });
        const snapshot = await this.verifyWrittenResult(
          result.commit.sha,
          path,
          desired,
        );
        this.telemetry({
          event: "mutation_succeeded",
          commitSha: result.commit.sha,
          durationMs: Date.now() - started,
        });
        return { ...result, snapshot };
      } catch (error) {
        if (error instanceof GitHubContentsError && error.code === "CONFLICT")
          continue;

        // A timeout/5xx can happen after GitHub accepted the write. Reconcile
        // against immutable content before deciding whether another write is safe.
        if (error instanceof GitHubContentsError && error.code === "UPSTREAM") {
          const reconciledHead = await this.resolveHead();
          const reconciled = await this.readOptional(path, reconciledHead);
          if (this.contentEquals(reconciled?.bytes ?? null, desired)) {
            const snapshot = await this.verifyWrittenResult(
              reconciledHead,
              path,
              desired,
            );
            return {
              commit: { sha: reconciledHead },
              content: reconciled ? { sha: reconciled.sha } : null,
              snapshot,
            };
          }
        }
        throw error;
      }
    }
    throw new PromptMutationConflict();
  }

  /** Atomic all-or-nothing reset; no sequential Contents API commits are used. */
  async reset(input: {
    expectedBranchSha: string;
    changes: readonly {
      path: string;
      expectedBlobSha: string | null;
      content?: string;
    }[];
    message: string;
  }) {
    if (input.changes.length === 0) throw new TypeError("Reset is empty");
    const changes = input.changes.map((change) => {
      const path = safePath(change.path, this.prefix);
      if (assertExpectedFile(path, this.prefix) !== "prompt")
        throw new TypeError("Only prompt files may be mutated");
      if (change.content !== undefined)
        validatePromptSnapshot([
          { path, content: change.content, type: "file" },
        ]);
      return { ...change, path };
    });
    for (let attempt = 0; attempt < MAX_HEAD_RETRIES; attempt++) {
      const head = await this.resolveHead();
      for (const change of changes) {
        const current = await this.readOptional(change.path, head);
        if ((current?.sha ?? null) !== change.expectedBlobSha)
          throw new PromptMutationConflict();
      }
      try {
        const result = await this.transport.mutateTree({
          branch: this.config.branch,
          expectedBranchSha: head,
          message: input.message,
          changes,
        });
        if ((await this.resolveHead()) !== result.commit.sha)
          throw new PromptMutationConflict();
        for (const change of changes) {
          const written = await this.readOptional(
            change.path,
            result.commit.sha,
          );
          const desired =
            change.content === undefined
              ? null
              : new TextEncoder().encode(change.content);
          if (!this.contentEquals(written?.bytes ?? null, desired))
            throw new PromptMutationConflict();
        }
        return { ...result, snapshot: await this.load(result.commit.sha) };
      } catch (error) {
        if (error instanceof GitHubContentsError && error.code === "CONFLICT")
          continue;
        throw error;
      }
    }
    throw new PromptMutationConflict();
  }

  private async readOptional(path: string, commitSha: string) {
    try {
      return await this.transport.read(path, commitSha);
    } catch (error) {
      if (error instanceof GitHubContentsError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  }

  private contentEquals(
    actual: Uint8Array | null,
    expected: Uint8Array | null,
  ) {
    return (
      actual === expected ||
      (actual !== null &&
        expected !== null &&
        Buffer.from(actual).equals(Buffer.from(expected)))
    );
  }

  private async verifyWrittenResult(
    commitSha: string,
    path: string,
    desired: Uint8Array | null,
  ) {
    // The symbolic branch must expose exactly the commit returned by the write;
    // otherwise activation could publish a snapshot we did not create.
    if ((await this.resolveHead()) !== commitSha)
      throw new PromptMutationConflict();
    const written = await this.readOptional(path, commitSha);
    if (!this.contentEquals(written?.bytes ?? null, desired))
      throw new PromptMutationConflict();
    // load() performs complete hierarchy/schema validation at this exact SHA.
    return this.load(commitSha);
  }
}
