import "server-only";

import { getToken } from "@vercel/connect";
import { translateConnectorError } from "./connector-error";
import { z } from "zod";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_RETRIES = 2;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SUPPORTED_EXTENSIONS = new Set([".md", ".json"]);
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

const contentFileSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
  sha: z.string().min(1),
  path: z.string(),
  name: z.string(),
  truncated: z.boolean().optional(),
});
const directoryItemSchema = z.object({
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  size: z.number().int().nonnegative(),
  sha: z.string().min(1),
  path: z.string(),
  name: z.string(),
});
const branchSchema = z.object({
  object: z.object({ sha: z.string().min(1), type: z.string() }),
});
const contentWriteSchema = z.object({
  content: z.object({ sha: z.string().min(1), path: z.string() }).nullable(),
  commit: z.object({ sha: z.string().min(1) }),
});
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  html_url: z.string().url(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().nullable().optional(),
});
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        changes: z.number().int().nonnegative().optional(),
      }),
    )
    .optional()
    .default([]),
});

export interface SkillsGitHubConfig {
  connector: string;
  owner: string;
  repository: string;
  branch: string;
  /** Repository-relative root. It must be `skills` or a directory below it. */
  prefix?: string;
}

export interface GitHubSkillsClientOptions {
  fetch?: typeof globalThis.fetch;
  tokenProvider?: typeof getToken;
  maxFileBytes?: number;
  maxReadRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  audit?: (event: GitHubClientEvent) => void | Promise<void>;
}

export interface GitHubClientEvent {
  operation:
    | "github.read"
    | "github.branch_created"
    | "github.commit"
    | "github.pull_request_created"
    | "github.merge_observed"
    | "github.rate_limited";
  result: "success" | "failure";
  durationMs: number;
  commitSha?: string;
  pullRequestNumber?: number;
  code?: string;
}

export type GitHubErrorKind =
  | "authentication"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "transient"
  | "invalid_response";

/** Deliberately contains no GitHub response body or repository coordinates. */
export class GitHubSkillsError extends Error {
  constructor(
    public readonly kind: GitHubErrorKind,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(`GitHub skills operation failed (${kind})`);
    this.name = "GitHubSkillsError";
  }
}

export interface SkillFile {
  path: string;
  sha: string;
  size: number;
  content: string;
}

export interface DirectoryEntry {
  path: string;
  name: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule";
}

export interface FileMutationResult {
  path: string;
  sha: string;
  commitSha: string;
}

export type PullRequest = z.infer<typeof pullRequestSchema>;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new TypeError("Skill path contains invalid percent encoding");
  }
}

function validateSegments(path: string): string[] {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    CONTROL_CHARACTER.test(path)
  ) {
    throw new TypeError("Skill path must be a safe repository-relative path");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    const decoded = decodeSegment(segment);
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      CONTROL_CHARACTER.test(decoded)
    ) {
      throw new TypeError("Skill path contains an unsafe segment");
    }
  }
  return segments;
}

/** Validates and returns the canonical repository path (without decoding it). */
function validatePath(
  path: string,
  prefix: string,
  requireFile: boolean,
): string {
  const prefixSegments = validateSegments(prefix);
  if (prefixSegments[0] !== "skills") {
    throw new TypeError(
      "The configured skill prefix must be skills or beneath it",
    );
  }
  const segments = validateSegments(path);
  if (
    segments.length < prefixSegments.length ||
    !prefixSegments.every((segment, index) => segment === segments[index])
  ) {
    throw new TypeError("Path is outside the configured skills prefix");
  }
  if (requireFile) {
    if (segments.length === prefixSegments.length) {
      throw new TypeError("A skill file must be beneath the configured prefix");
    }
    const fileName = segments.at(-1)!;
    const dot = fileName.lastIndexOf(".");
    if (
      dot <= 0 ||
      !SUPPORTED_EXTENSIONS.has(fileName.slice(dot).toLowerCase())
    ) {
      throw new TypeError("Unsupported skill file extension");
    }
  }
  return segments.join("/");
}

export function validateSkillPath(path: string, prefix = "skills"): string {
  return validatePath(path, prefix, true);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter))
    return Math.min(Number(retryAfter) * 1000, 30_000);
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    return Math.min(Math.max(Number(reset) * 1000 - Date.now(), 0), 30_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}

function errorFor(response: Response): GitHubSkillsError {
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")));
  if (rateLimited)
    return new GitHubSkillsError(
      "rate_limit",
      response.status,
      true,
      retryDelay(response, 0),
    );
  if (response.status === 401)
    return new GitHubSkillsError("authentication", 401, false);
  if (response.status === 403)
    return new GitHubSkillsError("forbidden", 403, false);
  if (response.status === 404)
    return new GitHubSkillsError("not_found", 404, false);
  if (response.status === 409 || response.status === 422)
    return new GitHubSkillsError("conflict", response.status, false);
  if (response.status >= 500)
    return new GitHubSkillsError(
      "transient",
      response.status,
      response.status >= 502 && response.status <= 504,
    );
  return new GitHubSkillsError("invalid_response", response.status, false);
}

export class GitHubSkillsClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly tokenProvider: typeof getToken;
  private readonly maxBytes: number;
  private readonly retries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly prefix: string;
  private readonly audit: (event: GitHubClientEvent) => void | Promise<void>;

  constructor(
    private readonly config: SkillsGitHubConfig,
    options: GitHubSkillsClientOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.tokenProvider = options.tokenProvider ?? getToken;
    this.maxBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
    this.retries = options.maxReadRetries ?? DEFAULT_RETRIES;
    this.audit = options.audit ?? (() => undefined);
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0)
      throw new TypeError("Invalid file byte limit");
    this.prefix = (config.prefix ?? "skills").replace(/\/$/, "");
    const prefixSegments = validateSegments(this.prefix);
    if (prefixSegments[0] !== "skills") throw new Error("SKILL_PREFIX_INVALID");
  }

  get controlledPrefix(): string {
    return this.prefix;
  }

  get defaultBranch(): string {
    return this.config.branch;
  }

  private emit(event: GitHubClientEvent): void {
    void Promise.resolve(this.audit(event)).catch(() => undefined);
  }

  private repoUrl(path: string): string {
    return `${API_ROOT}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}${path}`;
  }

  private async token(): Promise<string> {
    try {
      return await this.tokenProvider(this.config.connector, {
        subject: { type: "app" },
      });
    } catch (error) {
      throw translateConnectorError(error);
    }
  }

  private headers(token: string): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "telegram-agent-skills-client",
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  private async request(
    token: string,
    url: string,
    init: RequestInit = {},
    safeRead = false,
  ): Promise<Response> {
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetcher(url, {
        ...init,
        headers: { ...this.headers(token), ...init.headers },
      });
      if (response.ok) return response;
      const failure = errorFor(response);
      if (failure.kind === "rate_limit")
        this.emit({
          operation: "github.rate_limited",
          result: "failure",
          durationMs: Date.now() - started,
          code: "GITHUB_RATE_LIMITED",
        });
      if (!safeRead || !failure.retryable || attempt >= this.retries)
        throw failure;
      await response.body?.cancel();
      await this.sleep(retryDelay(response, attempt));
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new GitHubSkillsError("invalid_response", undefined, false);
    return result.data;
  }

  private path(path: string): string {
    return validateSkillPath(path, this.prefix);
  }

  private async readFileWithToken(
    token: string,
    path: string,
    ref: string,
  ): Promise<SkillFile> {
    const validPath = this.path(path);
    const response = await this.request(
      token,
      `${this.repoUrl(`/contents/${encodePath(validPath)}`)}?ref=${encodeURIComponent(ref)}`,
      {},
      true,
    );
    const file = this.parse(contentFileSchema, await response.json());
    if (file.truncated || file.size > this.maxBytes)
      throw new GitHubSkillsError("invalid_response", undefined, false);
    const encoded = file.content.replace(/\s/g, "");
    // Node's base64 decoder silently ignores invalid characters. Reject them
    // (and impossible padding) before decoding repository-controlled data.
    if (
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new GitHubSkillsError("invalid_response", undefined, false);
    const contentBytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (
      contentBytes.byteLength !== file.size ||
      contentBytes.byteLength > this.maxBytes
    )
      throw new GitHubSkillsError("invalid_response", undefined, false);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
    } catch {
      throw new GitHubSkillsError("invalid_response", undefined, false);
    }
    return { path: file.path, sha: file.sha, size: file.size, content };
  }

  async readFile(path: string, ref: string): Promise<SkillFile> {
    const started = Date.now();
    const token = await this.token();
    const file = await this.readFileWithToken(token, path, ref);
    this.emit({
      operation: "github.read",
      result: "success",
      durationMs: Date.now() - started,
      ...(SHA_PATTERN.test(ref) ? { commitSha: ref } : {}),
    });
    return file;
  }

  async listDirectory(path: string, ref: string): Promise<DirectoryEntry[]> {
    const token = await this.token();
    const validPath = validatePath(path, this.prefix, false);
    const entries: DirectoryEntry[] = [];
    // The contents endpoint is not paginated today; these parameters make the client forward-compatible.
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        ref,
        per_page: "100",
        page: String(page),
      });
      const response = await this.request(
        token,
        `${this.repoUrl(`/contents/${encodePath(validPath)}`)}?${query}`,
        {},
        true,
      );
      const batch = this.parse(
        z.array(directoryItemSchema),
        await response.json(),
      );
      entries.push(...batch);
      const link = response.headers.get("link");
      if (!link?.includes('rel="next"')) break;
    }
    return entries;
  }

  async getBranchHead(branch = this.config.branch): Promise<string> {
    const token = await this.token();
    const response = await this.request(
      token,
      this.repoUrl(`/git/ref/heads/${encodePath(branch)}`),
      {},
      true,
    );
    const ref = this.parse(branchSchema, await response.json());
    if (ref.object.type !== "commit")
      throw new GitHubSkillsError("invalid_response", undefined, false);
    return ref.object.sha;
  }

  async createBranch(branch: string, baseCommitSha: string): Promise<string> {
    const started = Date.now();
    const token = await this.token();
    const response = await this.request(token, this.repoUrl("/git/refs"), {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseCommitSha }),
    });
    const ref = this.parse(branchSchema, await response.json());
    this.emit({
      operation: "github.branch_created",
      result: "success",
      durationMs: Date.now() - started,
      commitSha: ref.object.sha,
    });
    return ref.object.sha;
  }

  async compareCommits(base: string, head: string) {
    const token = await this.token();
    const response = await this.request(
      token,
      this.repoUrl(
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      ),
      {},
      true,
    );
    const comparison = this.parse(comparisonSchema, await response.json());
    return {
      status: comparison.status,
      files: comparison.files.map((file) => ({
        path: file.filename,
        status: file.status,
      })),
    };
  }

  async putFile(input: {
    path: string;
    branch: string;
    content: string;
    message: string;
    expectedSha: string | null;
  }): Promise<FileMutationResult> {
    const started = Date.now();
    const token = await this.token();
    const path = this.path(input.path);
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > this.maxBytes)
      throw new TypeError("Skill file exceeds the upload byte limit");
    const body: Record<string, string> = {
      message: input.message,
      branch: input.branch,
      content: Buffer.from(bytes).toString("base64"),
    };
    if (input.expectedSha !== null) body.sha = input.expectedSha;
    // A write is never retried or inferred from matching content: that would
    // not prove which commit won, and a blob SHA is not a commit SHA.
    const response = await this.request(
      token,
      this.repoUrl(`/contents/${encodePath(path)}`),
      { method: "PUT", body: JSON.stringify(body) },
    );
    const result = this.parse(contentWriteSchema, await response.json());
    if (!result.content)
      throw new GitHubSkillsError("invalid_response", undefined, false);
    const mutation = {
      path: result.content.path,
      sha: result.content.sha,
      commitSha: result.commit.sha,
    };
    this.emit({
      operation: "github.commit",
      result: "success",
      durationMs: Date.now() - started,
      commitSha: mutation.commitSha,
    });
    return mutation;
  }

  async deleteFile(input: {
    path: string;
    branch: string;
    message: string;
    expectedSha: string;
  }): Promise<string> {
    const token = await this.token();
    const path = this.path(input.path);
    const response = await this.request(
      token,
      this.repoUrl(`/contents/${encodePath(path)}`),
      {
        method: "DELETE",
        body: JSON.stringify({
          message: input.message,
          branch: input.branch,
          sha: input.expectedSha,
        }),
      },
    );
    return this.parse(contentWriteSchema, await response.json()).commit.sha;
  }

  async openPullRequest(input: {
    title: string;
    body?: string;
    head: string;
    base?: string;
  }): Promise<PullRequest> {
    const started = Date.now();
    const token = await this.token();
    const response = await this.request(token, this.repoUrl("/pulls"), {
      method: "POST",
      body: JSON.stringify({
        ...input,
        base: input.base ?? this.config.branch,
      }),
    });
    const pull = this.parse(pullRequestSchema, await response.json());
    this.emit({
      operation: "github.pull_request_created",
      result: "success",
      durationMs: Date.now() - started,
      pullRequestNumber: pull.number,
      commitSha: pull.head.sha,
    });
    return pull;
  }

  async listPullRequests(
    input: {
      state?: "open" | "closed" | "all";
      head?: string;
      base?: string;
    } = {},
  ): Promise<PullRequest[]> {
    const token = await this.token();
    const pulls: PullRequest[] = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        state: input.state ?? "open",
        per_page: "100",
        page: String(page),
      });
      if (input.head) query.set("head", input.head);
      if (input.base) query.set("base", input.base);
      const response = await this.request(
        token,
        `${this.repoUrl("/pulls")}?${query}`,
        {},
        true,
      );
      pulls.push(
        ...this.parse(z.array(pullRequestSchema), await response.json()),
      );
      if (!response.headers.get("link")?.includes('rel="next"')) break;
    }
    return pulls;
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const started = Date.now();
    const token = await this.token();
    const response = await this.request(
      token,
      this.repoUrl(`/pulls/${number}`),
      {},
      true,
    );
    const pull = this.parse(pullRequestSchema, await response.json());
    if (pull.merged)
      this.emit({
        operation: "github.merge_observed",
        result: "success",
        durationMs: Date.now() - started,
        pullRequestNumber: pull.number,
        ...(pull.merge_commit_sha ? { commitSha: pull.merge_commit_sha } : {}),
      });
    return pull;
  }
}

export function createGitHubSkillsClient(
  config: SkillsGitHubConfig,
  options?: GitHubSkillsClientOptions,
): GitHubSkillsClient {
  return new GitHubSkillsClient(config, options);
}
