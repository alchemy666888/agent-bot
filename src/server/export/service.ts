import "server-only";

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { readSandboxConfig } from "../config";
import { ensureSandbox } from "../sandbox/controller";
import type { SandboxHandle } from "../sandbox/sdk-adapter";
import {
  installWorker,
  invokeWorker,
  streamSandboxFile,
} from "../sandbox/transport";
import { uuidV7 } from "../../shared/ids";

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");
const exportSchema = z
  .object({
    archivePath: z.string().startsWith("/tmp/telegram-agent/exports/"),
    filename: z.string().regex(/^telegram-agent-data-[0-9TZ-]+\.zip$/),
    size: z.number().int().nonnegative(),
  })
  .strict();

export interface PreparedExport {
  filename: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

export function streamWithCleanup(
  source: NodeJS.ReadableStream,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let cleaned = false;
  const cleanOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await iterator.next();
        if (value.done) {
          controller.close();
          await cleanOnce();
        } else controller.enqueue(Buffer.from(value.value as Uint8Array));
      } catch (error) {
        controller.error(error);
        await cleanOnce();
      }
    },
    async cancel() {
      if (source instanceof Readable) source.destroy();
      await iterator.return?.();
      await cleanOnce();
    },
  });
}

async function removeExport(sandbox: SandboxHandle, path: string) {
  await sandbox.runCommand("rm", ["-rf", dirname(path)]);
}

export async function prepareExport(): Promise<PreparedExport> {
  const sandbox = await ensureSandbox(readSandboxConfig());
  const workerPath = await installWorker(
    sandbox,
    await readFile(workerSourcePath),
  );
  const response = await invokeWorker(sandbox, workerPath, {
    contractVersion: 1,
    correlationId: uuidV7(),
    operation: "export",
    payload: {},
  });
  if (!response.ok) throw new Error("EXPORT_FAILED");
  const exported = exportSchema.parse(response.data);
  let source: NodeJS.ReadableStream;
  try {
    source = await streamSandboxFile(sandbox, exported.archivePath);
  } catch (error) {
    await removeExport(sandbox, exported.archivePath);
    throw error;
  }

  return {
    filename: exported.filename,
    size: exported.size,
    stream: streamWithCleanup(source, () =>
      removeExport(sandbox, exported.archivePath),
    ),
  };
}
