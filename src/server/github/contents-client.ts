import "server-only";

import { getToken } from "@vercel/connect";
import { translateConnectorError } from "./connector-error";
import { z } from "zod";

const SHA = /^[0-9a-f]{40}$/;
const API_VERSION = "2022-11-28";

export class GitHubContentsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | "AUTHENTICATION"
      | "AUTHORIZATION"
      | "NOT_FOUND"
      | "CONFLICT"
      | "UPSTREAM",
  ) {
    super(`GitHub contents request failed (${code})`);
  }
}

export type GitHubContentsEntry = {
  path: string;
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
  sha: string;
  size: number;
};

export type GitHubContentFile = GitHubContentsEntry & {
  type: "file";
  bytes: Uint8Array;
  etag?: string;
};

export interface GitHubContentsTransportOptions {
  fetch?: typeof globalThis.fetch;
  tokenProvider?: typeof getToken;
  maxBytes?: number;
}

/** Authenticated GitHub transport only. Callers own path and authorization policy. */
export class GitHubContentsTransport {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly tokenProvider: typeof getToken;
  private readonly maxBytes: number;

  constructor(
    private readonly config: {
      connector: string;
      owner: string;
      repository: string;
    },
    options: GitHubContentsTransportOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.tokenProvider = options.tokenProvider ?? getToken;
    this.maxBytes = options.maxBytes ?? 16 * 1024;
  }

  private url(path: string) {
    return `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}${path}`;
  }

  private async request(path: string, init: RequestInit = {}) {
    let token: string;
    try {
      token = await this.tokenProvider(this.config.connector, {
        subject: { type: "app" },
      });
    } catch (error) {
      throw translateConnectorError(error);
    }
    const response = await this.fetcher(this.url(path), {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "telegram-agent-contents-client",
        "X-GitHub-Api-Version": API_VERSION,
        ...init.headers,
      },
    });
    if (response.ok || response.status === 304) return response;
    const code =
      response.status === 401
        ? "AUTHENTICATION"
        : response.status === 403
          ? "AUTHORIZATION"
          : response.status === 404
            ? "NOT_FOUND"
            : response.status === 409 || response.status === 422
              ? "CONFLICT"
              : "UPSTREAM";
    await response.body?.cancel();
    throw new GitHubContentsError(response.status, code);
  }

  async resolveBranch(branch: string): Promise<string> {
    const response = await this.request(
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const value = z
      .object({
        object: z.object({ type: z.literal("commit"), sha: z.string() }),
      })
      .parse(await response.json());
    if (!SHA.test(value.object.sha)) throw new TypeError("Invalid commit SHA");
    return value.object.sha;
  }

  async list(path: string, commitSha: string): Promise<GitHubContentsEntry[]> {
    if (!SHA.test(commitSha))
      throw new TypeError("An immutable commit SHA is required");
    const response = await this.request(
      `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`,
    );
    return z
      .array(
        z.object({
          path: z.string(),
          name: z.string(),
          type: z.enum(["file", "dir", "symlink", "submodule"]),
          sha: z.string(),
          size: z.number().int().nonnegative(),
        }),
      )
      .parse(await response.json());
  }

  async read(
    path: string,
    commitSha: string,
    etag?: string,
  ): Promise<GitHubContentFile | null> {
    if (!SHA.test(commitSha))
      throw new TypeError("An immutable commit SHA is required");
    const response = await this.request(
      `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`,
      etag ? { headers: { "If-None-Match": etag } } : {},
    );
    if (response.status === 304) return null;
    const value = z
      .object({
        path: z.string(),
        name: z.string(),
        type: z.literal("file"),
        sha: z.string(),
        size: z.number().int().nonnegative(),
        encoding: z.literal("base64"),
        content: z.string(),
        truncated: z.boolean().optional(),
      })
      .parse(await response.json());
    if (value.truncated || value.size > this.maxBytes)
      throw new TypeError("GitHub file exceeds configured bound");
    const encoded = value.content.replace(/\s/g, "");
    if (
      encoded.length % 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new TypeError("Invalid GitHub base64 content");
    const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (bytes.byteLength !== value.size)
      throw new TypeError("GitHub size mismatch");
    return { ...value, bytes, etag: response.headers.get("etag") ?? undefined };
  }

  async mutate(input: {
    path: string;
    branch: string;
    expectedBranchSha: string;
    expectedBlobSha: string | null;
    content?: string;
    message: string;
  }) {
    if (!SHA.test(input.expectedBranchSha))
      throw new TypeError("Expected branch SHA is required");
    if (input.expectedBlobSha !== null && !SHA.test(input.expectedBlobSha))
      throw new TypeError("Expected blob SHA is invalid");
    const head = await this.resolveBranch(input.branch);
    if (head !== input.expectedBranchSha)
      throw new GitHubContentsError(409, "CONFLICT");
    const body: Record<string, string> = {
      branch: input.branch,
      message: input.message,
    };
    if (input.expectedBlobSha) body.sha = input.expectedBlobSha;
    if (input.content !== undefined) {
      const bytes = new TextEncoder().encode(input.content);
      if (bytes.byteLength > this.maxBytes)
        throw new TypeError("Upload exceeds configured bound");
      body.content = Buffer.from(bytes).toString("base64");
    }
    const response = await this.request(
      `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: input.content === undefined ? "DELETE" : "PUT",
        body: JSON.stringify(body),
      },
    );
    return z
      .object({
        commit: z.object({ sha: z.string().regex(SHA) }),
        content: z.object({ sha: z.string() }).nullable(),
      })
      .parse(await response.json());
  }

  /** Creates one commit for a multi-file change and advances the ref with CAS semantics. */
  async mutateTree(input: {
    branch: string;
    expectedBranchSha: string;
    message: string;
    changes: readonly { path: string; content?: string }[];
  }): Promise<{ commit: { sha: string } }> {
    if (!SHA.test(input.expectedBranchSha) || input.changes.length === 0)
      throw new TypeError("Expected branch SHA and changes are required");
    if ((await this.resolveBranch(input.branch)) !== input.expectedBranchSha)
      throw new GitHubContentsError(409, "CONFLICT");
    const parentResponse = await this.request(
      `/git/commits/${input.expectedBranchSha}`,
    );
    const parent = z
      .object({ tree: z.object({ sha: z.string().regex(SHA) }) })
      .parse(await parentResponse.json());
    const tree = [] as Array<{
      path: string;
      mode: "100644";
      type: "blob";
      sha: string | null;
    }>;
    for (const change of input.changes) {
      let sha: string | null = null;
      if (change.content !== undefined) {
        const bytes = new TextEncoder().encode(change.content);
        if (bytes.byteLength > this.maxBytes)
          throw new TypeError("Upload exceeds configured bound");
        const response = await this.request("/git/blobs", {
          method: "POST",
          body: JSON.stringify({
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
          }),
        });
        sha = z
          .object({ sha: z.string().regex(SHA) })
          .parse(await response.json()).sha;
      }
      tree.push({ path: change.path, mode: "100644", type: "blob", sha });
    }
    const treeResponse = await this.request("/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
    });
    const treeSha = z
      .object({ sha: z.string().regex(SHA) })
      .parse(await treeResponse.json()).sha;
    const commitResponse = await this.request("/git/commits", {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: treeSha,
        parents: [input.expectedBranchSha],
      }),
    });
    const commit = z
      .object({ sha: z.string().regex(SHA) })
      .parse(await commitResponse.json());
    await this.request(`/git/refs/heads/${encodeURIComponent(input.branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return { commit };
  }
}
