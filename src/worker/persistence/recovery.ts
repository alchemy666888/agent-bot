import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventSchema, type DurableEvent } from "./schemas";

export async function recoverJsonl(
  path: string,
  recoveryRoot: string,
): Promise<DurableEvent[]> {
  const source = await readFile(path);
  const lastNewline = source.lastIndexOf(10);
  if (lastNewline < source.length - 1) {
    const partial = source.subarray(lastNewline + 1);
    if (partial.length) {
      await mkdir(recoveryRoot, { recursive: true });
      await writeFile(
        join(recoveryRoot, `${Date.now()}-partial.bin`),
        partial,
        { mode: 0o600 },
      );
      await writeFile(path, source.subarray(0, lastNewline + 1));
    }
  }
  const text = source.subarray(0, lastNewline + 1).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => eventSchema.parse(JSON.parse(line)));
}

export async function quarantineInvalidProjection(
  path: string,
  recoveryRoot: string,
) {
  await mkdir(recoveryRoot, { recursive: true });
  await rename(
    path,
    join(recoveryRoot, `${Date.now()}-${path.split("/").at(-1)}`),
  );
}
