import "server-only";

import { getVercelOidcToken } from "@vercel/oidc";
import { Sandbox } from "@vercel/sandbox";
import { isMissingSandboxError, isStaleSnapshotError } from "./provider-error";

export interface CommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}
export interface SandboxHandle {
  name: string;
  region: string;
  mounts: Record<string, unknown>;
  status: string;
  update(params: {
    persistent?: boolean;
    timeout?: number;
    ports?: number[];
    region?: "sin1";
    failoverRegions?: string[];
    keepLastSnapshots?: { count: number };
  }): Promise<void>;
  stop(): Promise<unknown>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  runCommand(
    command: string,
    args?: string[],
    options?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandResult>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<CommandResult>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  readFile(file: { path: string }): Promise<NodeJS.ReadableStream | null>;
}
export interface SandboxCreateInput {
  name: string;
  region: "sin1";
  persistent: true;
  resume: boolean;
  timeout: number;
  keepLastSnapshots: { count: 1 };
}
export interface SandboxSdk {
  getOrCreateSandbox(input: SandboxCreateInput): Promise<SandboxHandle>;
  deleteSandbox?(name: string): Promise<void>;
}

interface OidcCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/**
 * `@vercel/sandbox` is externalized, so its copy of `@vercel/oidc` does not
 * see the request header the runtime gives the bundled copy. Read the token
 * here and pass it in. A missing token falls through to the SDK default,
 * which still works when `VERCEL_OIDC_TOKEN` is in the environment.
 */
async function oidcCredentials(): Promise<OidcCredentials | undefined> {
  try {
    const token = await getVercelOidcToken();
    const segment = token.split(".")[1];
    if (!segment) return undefined;
    const payload = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    ) as { owner_id?: unknown; project_id?: unknown };
    if (
      typeof payload.owner_id !== "string" ||
      payload.owner_id.length === 0 ||
      typeof payload.project_id !== "string" ||
      payload.project_id.length === 0
    )
      return undefined;
    return {
      token,
      teamId: payload.owner_id,
      projectId: payload.project_id,
    };
  } catch {
    return undefined;
  }
}

function creationParams(input: SandboxCreateInput) {
  return {
    name: input.name,
    region: input.region,
    persistent: input.persistent,
    timeout: input.timeout,
    keepLastSnapshots: input.keepLastSnapshots,
  };
}

async function deleteSandboxHttp(
  name: string,
  credentials: OidcCredentials,
): Promise<void> {
  const url = new URL(
    `https://vercel.com/api/v2/sandboxes/${encodeURIComponent(name)}`,
  );
  url.searchParams.set("projectId", credentials.projectId);
  url.searchParams.set("teamId", credentials.teamId);
  url.searchParams.set("deleteOrphanSnapshots", "true");
  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  if (response.status === 404 || response.ok) return;
  throw new Error("SANDBOX_UNAVAILABLE");
}

async function discardSandbox(name: string): Promise<void> {
  const credentials = await oidcCredentials();
  try {
    const existing = await Sandbox.get({
      name,
      resume: false,
      ...credentials,
    });
    await existing.delete({ deleteOrphanSnapshots: true });
  } catch (error) {
    if (isMissingSandboxError(error)) return;
    if (!isStaleSnapshotError(error) || !credentials) throw error;
    await deleteSandboxHttp(name, credentials);
  }
}

export const vercelSandboxSdk: SandboxSdk = {
  async getOrCreateSandbox(input) {
    const credentials = await oidcCredentials();
    // Do not resume during lookup. Resuming a sandbox whose snapshot has
    // expired fails the turn before a replacement can be created.
    const params = {
      ...creationParams(input),
      resume: false as const,
      ...credentials,
    };
    try {
      return (await Sandbox.getOrCreate(params)) as unknown as SandboxHandle;
    } catch (error) {
      if (!isStaleSnapshotError(error)) throw error;
      await discardSandbox(input.name);
      return (await Sandbox.create({
        ...creationParams(input),
        ...credentials,
      })) as unknown as SandboxHandle;
    }
  },
  deleteSandbox: discardSandbox,
};
