import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGoogleDriveClient } from "../../../src/shared/google-drive/client";
import {
  GOOGLE_DRIVE_FOLDER_ID,
  type GoogleDriveConfig,
} from "../../../src/shared/google-drive/config";
import {
  controllerLogPath,
  persistControllerLog,
} from "../../../src/shared/google-drive/controller-log";
import { MemoryDrive } from "../../../src/shared/google-drive/memory";
import type { DriveStore } from "../../../src/shared/google-drive/store";
import { uuidV7 } from "../../../src/shared/ids";
import { atomicJson } from "../../../src/worker/persistence/atomic-json";
import { notifyCommit } from "../../../src/worker/persistence/commit";
import {
  bindDriveSession,
  syncScratch,
  uploadCommitted,
} from "../../../src/worker/persistence/drive-sync";
import { writeWorkerLog } from "../../../src/worker/observability/worker-log";

const config: GoogleDriveConfig = {
  GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "client-value",
  GOOGLE_REFRESH_TOKEN: "refresh-value",
};

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("Google Drive scratch sync", () => {
  it("rejects paths outside data and logs", async () => {
    const store = new MemoryDrive();
    await expect(
      store.upload("runtime/locks/mutation.lock", Buffer.from("x")),
    ).rejects.toThrow("DRIVE_PATH_REJECTED");
    await expect(
      store.upload("data/../secret.json", Buffer.from("x")),
    ).rejects.toThrow("DRIVE_PATH_REJECTED");
  });

  it("hydrates an empty scratch and leaves an existing manifest in place", async () => {
    root = await mkdtemp(join(tmpdir(), "drive-sync-"));
    const store = new MemoryDrive();
    await store.upload(
      "data/manifest.json",
      Buffer.from('{"schemaVersion":1}\n'),
    );
    await store.upload(
      "logs/worker/2026-09.jsonl",
      Buffer.from('{"component":"worker"}\n'),
    );
    await store.upload(
      "logs/controller/skip.json",
      Buffer.from('{"component":"controller"}'),
    );
    await syncScratch(root, store);
    expect(await readFile(join(root, "data/manifest.json"), "utf8")).toContain(
      "schemaVersion",
    );
    expect(
      await readFile(join(root, "logs/worker/2026-09.jsonl"), "utf8"),
    ).toContain("worker");
    await expect(
      readFile(join(root, "logs/controller/skip.json"), "utf8"),
    ).rejects.toThrow();

    await writeFile(join(root, "data/manifest.json"), "local");
    await store.upload("data/manifest.json", Buffer.from("remote"));
    await syncScratch(root, store);
    expect(await readFile(join(root, "data/manifest.json"), "utf8")).toBe(
      "local",
    );
  });

  it("uploads committed files and flushes a dirty scratch", async () => {
    root = await mkdtemp(join(tmpdir(), "drive-sync-"));
    const store = new MemoryDrive();
    await bindDriveSession(root, store, async () => {
      await atomicJson(join(root, "data/manifest.json"), { schemaVersion: 1 });
      await notifyCommit(join(root, "runtime/locks/ignored.json"));
    });
    expect(store.files.get("data/manifest.json")?.toString()).toContain(
      "schemaVersion",
    );
    expect([...store.files.keys()]).not.toContain("runtime/locks/ignored.json");

    await mkdir(join(root, "runtime"), { recursive: true });
    await mkdir(join(root, "data/state/users"), { recursive: true });
    await writeFile(join(root, "runtime/drive-dirty"), "1");
    await writeFile(join(root, "data/state/users/a.json"), '{"id":"a"}\n');
    await syncScratch(root, store);
    expect(store.files.get("data/state/users/a.json")?.toString()).toContain(
      '"id":"a"',
    );
    await expect(
      readFile(join(root, "runtime/drive-dirty"), "utf8"),
    ).rejects.toThrow();
  });

  it("retries a transient upload and then fails closed", async () => {
    root = await mkdtemp(join(tmpdir(), "drive-sync-"));
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data/manifest.json"), '{"schemaVersion":1}\n');
    let attempts = 0;
    const flaky: DriveStore = {
      listFiles: async () => [],
      download: async () => Buffer.from(""),
      delete: async () => undefined,
      upload: async () => {
        attempts += 1;
        if (attempts < 3)
          throw Object.assign(new Error("DRIVE_REQUEST_FAILED"), {
            status: 503,
          });
      },
    };
    await expect(
      uploadCommitted(root, join(root, "data/manifest.json"), flaky),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);

    const permanent: DriveStore = {
      ...flaky,
      upload: async () => {
        throw Object.assign(new Error("DRIVE_REQUEST_FAILED"), { status: 400 });
      },
    };
    await expect(
      uploadCommitted(root, join(root, "data/manifest.json"), permanent),
    ).rejects.toThrow("DRIVE_REQUEST_FAILED");
  });

  it("writes one redacted controller file and a worker monthly log", async () => {
    root = await mkdtemp(join(tmpdir(), "drive-sync-"));
    const store = new MemoryDrive();
    const correlationId = uuidV7();
    await persistControllerLog(
      {
        correlationId,
        component: "controller",
        operation: "download",
        stage: "archive-ready",
        result: "failure",
        metadata: { authorization: "Bearer secret-value", note: "kept" },
      },
      store,
    );
    const controllerPath = controllerLogPath({
      correlationId,
      component: "controller",
      operation: "download",
      stage: "archive-ready",
      result: "failure",
    });
    const controllerBody = store.files.get(controllerPath)?.toString() ?? "";
    expect(controllerBody).toContain("kept");
    expect(controllerBody).not.toMatch(/authorization|secret-value/i);

    await bindDriveSession(root, store, () =>
      writeWorkerLog(
        root,
        {
          correlationId,
          component: "worker",
          operation: "query",
          stage: "complete",
          result: "success",
          metadata: { token: "refresh-value" },
        },
        store,
      ),
    );
    const workerLog = [...store.files.entries()]
      .find(([path]) => path.startsWith("logs/worker/"))?.[1]
      .toString();
    expect(workerLog).toContain("query");
    expect(workerLog).not.toMatch(/token|refresh-value/i);
  });
});

describe("Google Drive HTTP client", () => {
  it("creates, updates, and downloads a file only inside the configured folder", async () => {
    const folders = new Map<
      string,
      Map<string, { id: string; mimeType: string; body?: Buffer }>
    >();
    folders.set(GOOGLE_DRIVE_FOLDER_ID, new Map());
    let sequence = 1;
    let tokenCalls = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        tokenCalls += 1;
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        expect(String(init?.body)).toContain("client_id=client");
        return Response.json({
          access_token: "access-token",
          expires_in: 3600,
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer access-token",
      );
      const method = init?.method ?? "GET";
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        const query = new URL(url).searchParams.get("q") ?? "";
        expect(query).toContain("in parents");
        const parent = query.match(/'([^']+)' in parents/)?.[1] ?? "";
        const name = query.match(/name = '([^']+)'/)?.[1];
        const directory = folders.get(parent) ?? new Map();
        const files = [...directory.entries()]
          .filter(([entryName]) => !name || entryName === name)
          .map(([entryName, entry]) => ({
            id: entry.id,
            name: entryName,
            mimeType: entry.mimeType,
          }));
        return Response.json({ files });
      }
      if (
        url === "https://www.googleapis.com/drive/v3/files" &&
        method === "POST"
      ) {
        const metadata = JSON.parse(String(init?.body)) as {
          name: string;
          mimeType: string;
          parents: string[];
        };
        const id = `folder-${sequence++}`;
        const parent = folders.get(metadata.parents[0] ?? "") ?? new Map();
        parent.set(metadata.name, { id, mimeType: metadata.mimeType });
        folders.set(metadata.parents[0] ?? "", parent);
        folders.set(id, new Map());
        return Response.json({ id });
      }
      if (url.includes("uploadType=multipart")) {
        const raw = Buffer.from(init?.body as Uint8Array);
        const metadata = JSON.parse(
          raw.toString("utf8").match(/\{[^{}]+\}/)?.[0] ?? "{}",
        ) as { name: string; parents: string[] };
        const marker = Buffer.from(
          "Content-Type: application/octet-stream\r\n\r\n",
        );
        const start = raw.indexOf(marker) + marker.length;
        const end = raw.lastIndexOf(Buffer.from("\r\n--"));
        const id = `file-${sequence++}`;
        const parent = folders.get(metadata.parents[0] ?? "");
        parent?.set(metadata.name, {
          id,
          mimeType: "application/octet-stream",
          body: raw.subarray(start, end),
        });
        return Response.json({ id });
      }
      if (method === "PATCH" && url.includes("uploadType=media")) {
        const id = url.match(/files\/([^?]+)/)?.[1];
        const body = Buffer.from(init?.body as Uint8Array);
        for (const directory of folders.values()) {
          for (const entry of directory.values()) {
            if (entry.id === id) entry.body = body;
          }
        }
        return Response.json({ id });
      }
      if (url.includes("alt=media")) {
        const id = url.match(/files\/([^?]+)/)?.[1];
        for (const directory of folders.values()) {
          for (const entry of directory.values()) {
            if (entry.id === id && entry.body)
              return new Response(new Uint8Array(entry.body));
          }
        }
      }
      return new Response("", { status: 404 });
    };

    const store = createGoogleDriveClient(config, fetchImpl);
    await expect(
      store.upload("runtime/locks/a.json", Buffer.from("x")),
    ).rejects.toThrow("DRIVE_PATH_REJECTED");
    expect(tokenCalls).toBe(0);
    await store.upload(
      "data/manifest.json",
      Buffer.from('{"schemaVersion":1}\n'),
    );
    await store.upload(
      "logs/controller/abc.json",
      Buffer.from('{"component":"controller"}'),
    );
    await store.upload(
      "data/manifest.json",
      Buffer.from('{"schemaVersion":2}\n'),
    );
    expect(await store.download("data/manifest.json")).toEqual(
      Buffer.from('{"schemaVersion":2}\n'),
    );
    expect(await store.listFiles(["logs/worker/"])).toEqual([]);
    expect(await store.listFiles(["data/"])).toEqual([
      { relativePath: "data/manifest.json" },
    ]);
  });
});
