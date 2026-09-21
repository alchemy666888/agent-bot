import "server-only";

import { randomUUID, createHash } from "node:crypto";
import {
  workerRequestSchema,
  workerResponseSchema,
  type WorkerRequest,
  type WorkerResponse,
} from "../../shared/contracts";
import type { SandboxHandle } from "./sdk-adapter";

const RUNTIME_ROOT = "/tmp/telegram-agent";
export const workerBundlePath = (source: Buffer) =>
  `${RUNTIME_ROOT}/worker-${createHash("sha256").update(source).digest("hex")}.mjs`;

export async function installWorker(
  sandbox: SandboxHandle,
  source: Buffer,
): Promise<string> {
  const path = workerBundlePath(source);
  const probe = await sandbox.runCommand("test", ["-f", path]);
  if (probe.exitCode !== 0)
    await sandbox.writeFiles([{ path, content: source }]);
  return path;
}

export async function invokeWorker(
  sandbox: SandboxHandle,
  workerPath: string,
  request: WorkerRequest,
  env: Record<string, string> = {},
): Promise<WorkerResponse> {
  const valid = workerRequestSchema.parse(request);
  const nonce = randomUUID();
  const requestPath = `${RUNTIME_ROOT}/requests/${nonce}.json`;
  const responsePath = `${RUNTIME_ROOT}/responses/${nonce}.json`;
  try {
    await sandbox.writeFiles([
      { path: requestPath, content: Buffer.from(JSON.stringify(valid)) },
    ]);
    const result = await sandbox.runCommand(
      "node",
      [workerPath, valid.operation, requestPath, responsePath],
      { env, timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) throw new Error("WORKER_COMMAND_FAILED");
    const response = await sandbox.readFileToBuffer({ path: responsePath });
    if (!response) throw new Error("WORKER_RESPONSE_MISSING");
    return workerResponseSchema.parse(JSON.parse(response.toString("utf8")));
  } finally {
    await sandbox.runCommand("rm", ["-f", requestPath, responsePath]);
  }
}

export async function streamSandboxFile(
  sandbox: SandboxHandle,
  path: string,
): Promise<NodeJS.ReadableStream> {
  const stream = await sandbox.readFile({ path });
  if (!stream) throw new Error("SANDBOX_FILE_MISSING");
  return stream;
}
