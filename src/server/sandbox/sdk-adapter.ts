import "server-only";

import { Drive, Sandbox } from "@vercel/sandbox";

export interface DriveHandle {
  name: string;
  region: string;
  currentSandboxName?: string;
}
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
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  runCommand(
    command: string,
    args?: string[],
    options?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandResult>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  readFile(file: { path: string }): Promise<NodeJS.ReadableStream | null>;
}
export interface SandboxSdk {
  getOrCreateDrive(input: {
    name: string;
    region: "sin1";
  }): Promise<DriveHandle>;
  getOrCreateSandbox(input: {
    name: string;
    region: "sin1";
    mounts: Record<"/workspace", DriveHandle>;
    persistent: true;
    resume: true;
    timeout: number;
    keepLastSnapshots: { count: 1 };
  }): Promise<SandboxHandle>;
}

export const vercelSandboxSdk: SandboxSdk = {
  getOrCreateDrive: (input) => Drive.getOrCreate(input),
  getOrCreateSandbox: (input) =>
    Sandbox.getOrCreate(
      input as unknown as Parameters<typeof Sandbox.getOrCreate>[0],
    ) as unknown as Promise<SandboxHandle>,
};
