import { GOOGLE_DRIVE_FOLDER_ID, type GoogleDriveConfig } from "./config";
import { assertDriveRelativePath } from "./paths";
import type { DriveStore } from "./store";

const FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("DRIVE_REQUEST_FAILED");
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface DriveChild {
  id: string;
  name: string;
  mimeType: string;
}

export function createGoogleDriveClient(
  config: GoogleDriveConfig,
  fetchImpl: FetchLike = fetch,
): DriveStore {
  if (config.GOOGLE_DRIVE_FOLDER_ID !== GOOGLE_DRIVE_FOLDER_ID)
    throw new Error("DRIVE_PATH_REJECTED");
  return new GoogleDriveClient(config, fetchImpl);
}

class GoogleDriveClient implements DriveStore {
  private token = "";
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: GoogleDriveConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  async listFiles(prefixes: string[]): Promise<{ relativePath: string }[]> {
    const found: { relativePath: string }[] = [];
    const queue: { id: string; path: string }[] = [
      { id: this.config.GOOGLE_DRIVE_FOLDER_ID, path: "" },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of await this.listChildren(current.id)) {
        const relativePath = current.path
          ? `${current.path}/${child.name}`
          : child.name;
        if (child.mimeType === FOLDER_MIME) {
          if (shouldDescend(relativePath, prefixes))
            queue.push({ id: child.id, path: relativePath });
        } else if (prefixes.some((prefix) => relativePath.startsWith(prefix))) {
          found.push({ relativePath });
        }
      }
    }
    return found;
  }

  async download(relativePath: string): Promise<Buffer> {
    assertDriveRelativePath(relativePath);
    const file = await this.resolve(relativePath, false);
    if (!file.id) throw new DriveRequestError(404);
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async upload(relativePath: string, body: Buffer): Promise<void> {
    assertDriveRelativePath(relativePath);
    const file = await this.resolve(relativePath, true);
    if (file.id) {
      await this.request(
        `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(body),
        },
      );
      return;
    }
    const boundary = `telegram-agent-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({
      name: file.name,
      parents: [file.parentId],
    });
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: new Uint8Array(payload),
      },
    );
  }

  async delete(relativePath: string): Promise<void> {
    assertDriveRelativePath(relativePath);
    const file = await this.resolve(relativePath, false);
    if (!file.id) return;
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files/${file.id}`,
      { method: "DELETE" },
      true,
    );
    if (response.status === 404) return;
    if (!response.ok) throw new DriveRequestError(response.status);
  }

  private async resolve(
    relativePath: string,
    createFolders: boolean,
  ): Promise<{ parentId: string; name: string; id?: string }> {
    const segments = relativePath.split("/");
    const name = segments.at(-1)!;
    let parentId: string = this.config.GOOGLE_DRIVE_FOLDER_ID;
    for (const segment of segments.slice(0, -1)) {
      const existing = await this.findChild(parentId, segment);
      if (existing?.mimeType === FOLDER_MIME) {
        parentId = existing.id;
        continue;
      }
      if (!createFolders) return { parentId, name };
      parentId = await this.createFolder(parentId, segment);
    }
    const file = await this.findChild(parentId, name);
    return {
      parentId,
      name,
      id: file && file.mimeType !== FOLDER_MIME ? file.id : undefined,
    };
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const response = await this.request(
      "https://www.googleapis.com/drive/v3/files",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: FOLDER_MIME,
          parents: [parentId],
        }),
      },
    );
    const created = (await response.json()) as { id?: string };
    if (!created.id) throw new DriveRequestError(502);
    return created.id;
  }

  private async findChild(
    parentId: string,
    name: string,
  ): Promise<DriveChild | undefined> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("DRIVE_PATH_REJECTED");
    const children = await this.listChildren(parentId, name);
    return children.find((child) => child.name === name);
  }

  private async listChildren(
    parentId: string,
    name?: string,
  ): Promise<DriveChild[]> {
    const children: DriveChild[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: name
          ? `name = '${name}' and '${parentId}' in parents and trashed = false`
          : `'${parentId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType)",
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(
        `https://www.googleapis.com/drive/v3/files?${params}`,
      );
      const page = (await response.json()) as {
        nextPageToken?: string;
        files?: DriveChild[];
      };
      children.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return children;
  }

  private async request(
    url: string,
    init: RequestInit = {},
    allowNotFound = false,
    retried = false,
  ): Promise<Response> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    if (response.status === 401 && !retried) {
      this.token = "";
      return this.request(url, init, allowNotFound, true);
    }
    if (allowNotFound && response.status === 404) return response;
    if (!response.ok) throw new DriveRequestError(response.status);
    return response;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const body = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID,
      client_secret: this.config.GOOGLE_CLIENT_SECRET,
      refresh_token: this.config.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    });
    const response = await this.fetchImpl(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    if (!response.ok) throw new DriveRequestError(response.status);
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) throw new DriveRequestError(502);
    this.token = payload.access_token;
    this.tokenExpiresAt =
      Date.now() + (payload.expires_in ?? 3600) * 1000 - 60_000;
    return this.token;
  }
}

function shouldDescend(folderPath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return (
      directory === folderPath ||
      directory.startsWith(`${folderPath}/`) ||
      folderPath.startsWith(`${directory}/`)
    );
  });
}
