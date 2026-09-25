import { createReadStream, createWriteStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { once } from "node:events";

interface ZipEntry {
  name: string;
  crc: number;
  size: number;
  offset: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0;
  return crc;
});

function header(signature: number, size: number): Buffer {
  const value = Buffer.alloc(size);
  value.writeUInt32LE(signature, 0);
  return value;
}

function dosTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("EXPORT_SYMLINK_REJECTED");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(child);
      else throw new Error("EXPORT_FILE_TYPE_REJECTED");
    }
  }
  await visit(root);
  return result;
}

/** Creates a ZIP using stored entries while keeping file contents out of memory. */
export async function createZip(
  sourceRoot: string,
  target: string,
): Promise<number> {
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  let offset = 0;
  const entries: ZipEntry[] = [];
  const write = async (chunk: Buffer) => {
    offset += chunk.length;
    if (!output.write(chunk)) await once(output, "drain");
  };

  try {
    for (const path of await filesUnder(sourceRoot)) {
      const info = await stat(path);
      if (info.size > 0xffffffff) throw new Error("EXPORT_ZIP64_REQUIRED");
      const name = Buffer.from(
        `${basename(sourceRoot)}/${relative(sourceRoot, path).split(sep).join("/")}`,
      );
      const timestamp = dosTime(info.mtime);
      const localOffset = offset;
      const local = header(0x04034b50, 30);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x808, 6); // UTF-8 and trailing data descriptor.
      local.writeUInt16LE(timestamp.time, 10);
      local.writeUInt16LE(timestamp.date, 12);
      local.writeUInt16LE(name.length, 26);
      await write(Buffer.concat([local, name]));

      let crc = 0xffffffff;
      let size = 0;
      for await (const value of createReadStream(path)) {
        const chunk = Buffer.from(value as Uint8Array);
        size += chunk.length;
        for (const byte of chunk)
          crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
        await write(chunk);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = header(0x08074b50, 16);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      entries.push({ name: name.toString(), crc, size, offset: localOffset });
    }

    const centralOffset = offset;
    for (const entry of entries) {
      const name = Buffer.from(entry.name);
      const central = header(0x02014b50, 46);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x808, 8);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.size, 20);
      central.writeUInt32LE(entry.size, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(entry.offset, 42);
      await write(Buffer.concat([central, name]));
    }
    const end = header(0x06054b50, 22);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(end);
    output.end();
    await once(output, "close");
    return offset;
  } catch (error) {
    output.destroy();
    throw error;
  }
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
