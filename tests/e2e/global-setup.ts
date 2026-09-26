import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2E_ROOT } from "./constants";

const kinds = [
  "users",
  "conversations",
  "messages",
  "updates",
  "model-runs",
  "errors",
];

export default async function globalSetup(): Promise<void> {
  await rm(E2E_ROOT, { recursive: true, force: true });
  for (const kind of kinds) {
    await mkdir(join(E2E_ROOT, "data/state", kind), { recursive: true });
    await mkdir(join(E2E_ROOT, "data/records", kind), { recursive: true });
  }
  await mkdir(join(E2E_ROOT, "data/recovery/quarantine"), { recursive: true });
  await writeFile(
    join(E2E_ROOT, "data/manifest.json"),
    JSON.stringify({ schemaVersion: 1 }),
  );
  for (let index = 0; index < 51; index += 1) {
    await writeFile(
      join(E2E_ROOT, "data/state/users", `${index}.json`),
      JSON.stringify({
        schemaVersion: 1,
        entityId: String(index),
        telegramUserId: String(1000 + index),
        username: index === 7 ? "Needle" : `user-${index}`,
        languageCode: "en",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
        revision: 1,
      }),
    );
  }
  await writeFile(
    join(E2E_ROOT, "data/state/conversations/conv-1.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "conv-1",
      entityId: "conv-1",
      userId: "1007",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    }),
  );
  await writeFile(
    join(E2E_ROOT, "data/state/messages/msg-1.json"),
    JSON.stringify({
      id: "msg-1",
      conversationId: "conv-1",
      role: "user",
      text: "Hello from history",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  await writeFile(
    join(E2E_ROOT, "data/state/model-runs/run-priced.json"),
    JSON.stringify({
      id: "run-priced",
      model: "deepseek-v4-pro",
      inputCount: 2,
      outputCount: 3,
      estimatedCost: "0.000008",
      latencyMs: 12,
    }),
  );
  await writeFile(
    join(E2E_ROOT, "data/state/model-runs/run-missing.json"),
    JSON.stringify({
      id: "run-missing",
      model: "deepseek-v4-pro",
      inputCount: null,
      outputCount: null,
      estimatedCost: null,
    }),
  );
  await writeFile(
    join(E2E_ROOT, "data/state/errors/err-1.json"),
    JSON.stringify({
      id: "err-1",
      stage: "model",
      code: "PROVIDER_FAILED",
      message: "The provider request failed",
    }),
  );
}
