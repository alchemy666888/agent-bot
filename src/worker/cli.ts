import { readFile, writeFile } from "node:fs/promises";
import { workerRequestSchema, workerResponseSchema } from "../shared/contracts";

async function main() {
  const [, , operation, requestPath, responsePath] = process.argv;
  if (!operation || !requestPath || !responsePath)
    throw new Error("INVALID_WORKER_INVOCATION");
  const request = workerRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  if (request.operation !== operation) throw new Error("OPERATION_MISMATCH");
  const response = workerResponseSchema.parse({
    contractVersion: 1,
    correlationId: request.correlationId,
    ok: true,
    data: {},
  });
  await writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
}

void main();
