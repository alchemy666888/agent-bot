import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { eventSchema, type DurableEvent } from "./schemas";
import { projectEvent } from "./projector";
import { recordKinds } from "./layout";

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

export async function rebuildProjections(root: string): Promise<number> {
  await rm(join(root, "data", "state"), { recursive: true, force: true });
  const latest = new Map<string, DurableEvent>();
  for (const kind of recordKinds) {
    const directory = join(root, "data", "records", kind);
    for (const file of (await readdir(directory).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()) {
      for (const event of await recoverJsonl(
        join(directory, file),
        join(root, "data", "recovery", "quarantine"),
      )) {
        const key = `${event.kind}:${event.entityId}`;
        if (!latest.has(key) || latest.get(key)!.revision < event.revision)
          latest.set(key, event);
      }
    }
  }
  for (const event of latest.values()) await projectEvent(root, event);
  return latest.size;
}
