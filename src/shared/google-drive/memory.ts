import { assertDriveRelativePath } from "./paths";
import type { DriveStore } from "./store";

export class MemoryDrive implements DriveStore {
  readonly files = new Map<string, Buffer>();

  async listFiles(prefixes: string[]): Promise<{ relativePath: string }[]> {
    return [...this.files.keys()]
      .filter((relativePath) =>
        prefixes.some((prefix) => relativePath.startsWith(prefix)),
      )
      .map((relativePath) => ({ relativePath }));
  }

  async download(relativePath: string): Promise<Buffer> {
    assertDriveRelativePath(relativePath);
    const body = this.files.get(relativePath);
    if (!body)
      throw Object.assign(new Error("DRIVE_FILE_MISSING"), { status: 404 });
    return Buffer.from(body);
  }

  async upload(relativePath: string, body: Buffer): Promise<void> {
    assertDriveRelativePath(relativePath);
    this.files.set(relativePath, Buffer.from(body));
  }

  async delete(relativePath: string): Promise<void> {
    assertDriveRelativePath(relativePath);
    this.files.delete(relativePath);
  }
}
