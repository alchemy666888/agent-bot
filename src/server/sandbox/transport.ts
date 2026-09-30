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
const commandFailureCodes: ReadonlyArray<[RegExp, string]> = [
  [/Dynamic require of .+ is not supported/i, "WORKER_BUNDLE_INCOMPATIBLE"],
  [
    /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
    "WORKER_MODULE_MISSING",
  ],
  [/WORKER_CONFIGURATION_INVALID/, "WORKER_CONFIGURATION_INVALID"],
  [/password authentication failed/i, "DATABASE_AUTHENTICATION_FAILED"],
  [
    /self[- ]signed certificate|certificate has expired|unable to verify/i,
    "DATABASE_TLS_FAILED",
  ],
  [/ECONNREFUSED/, "DATABASE_CONNECTION_REFUSED"],
  [/ENETUNREACH/, "DATABASE_NETWORK_UNREACHABLE"],
  [/ENOTFOUND|getaddrinfo/i, "DATABASE_HOST_NOT_FOUND"],
  [
    /ETIMEDOUT|connection terminated|timeout expired/i,
    "DATABASE_CONNECTION_FAILED",
  ],
];

async function commandFailureCode(result: {
  stderr(): Promise<string>;
}): Promise<string> {
  // Never forward command output: it can contain request data or secrets.
  const stderr = await result.stderr().catch(() => "");
  return (
    commandFailureCodes.find(([pattern]) => pattern.test(stderr))?.[1] ??
    "WORKER_COMMAND_FAILED"
  );
}

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
    // The SDK positional form keeps only signal and timeout. Operation
    // secrets must use the object form or they never reach the worker.
    const result = await sandbox.runCommand({
      cmd: "node",
      args: [workerPath, valid.operation, requestPath, responsePath],
      env,
      timeoutMs: 180_000,
    });
    if (result.exitCode !== 0)
      throw new Error(await commandFailureCode(result));
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
