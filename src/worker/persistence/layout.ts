import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicJson } from "./atomic-json";

export const DATA_ROOT = "/workspace/telegram-agent/data";
export const RUNTIME_ROOT = "/workspace/telegram-agent/runtime";
export const recordKinds = [
  "users",
  "conversations",
  "messages",
  "updates",
  "model-runs",
  "errors",
] as const;
export type RecordKind = (typeof recordKinds)[number];
export const monthPartition = (date: Date) => date.toISOString().slice(0, 7);
export const recordPath = (root: string, kind: RecordKind, date: Date) =>
  join(root, "data", "records", kind, `${monthPartition(date)}.jsonl`);
export const statePath = (
  root: string,
  kind: RecordKind | "summary",
  id?: string,
) =>
  kind === "summary"
    ? join(root, "data", "state", "summary.json")
    : join(root, "data", "state", kind, `${id}.json`);

export async function initializeLayout(root: string): Promise<void> {
  for (const kind of recordKinds) {
    await mkdir(join(root, "data", "records", kind), { recursive: true });
    await mkdir(join(root, "data", "state", kind), { recursive: true });
  }
  await mkdir(join(root, "data", "recovery", "quarantine"), {
    recursive: true,
  });
  await mkdir(join(root, "runtime", "locks"), { recursive: true });
  await atomicJson(join(root, "data", "manifest.json"), { schemaVersion: 1 });
}
