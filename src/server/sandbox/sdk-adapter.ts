import "server-only";

import { Sandbox } from "@vercel/sandbox";

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
export interface SandboxSdk {
  getOrCreateSandbox(input: {
    name: string;
    region: "sin1";
    persistent: true;
    resume: true;
    timeout: number;
    keepLastSnapshots: { count: 1 };
  }): Promise<SandboxHandle>;
}

export const vercelSandboxSdk: SandboxSdk = {
  getOrCreateSandbox: (input) =>
    Sandbox.getOrCreate(
      input as unknown as Parameters<typeof Sandbox.getOrCreate>[0],
    ) as unknown as Promise<SandboxHandle>,
};
