import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat();
}

describe("security boundaries", () => {
  it("excludes databases, object stores, throttles, moderation, and tools", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    expect(names.join("\n")).not.toMatch(
      /postgres|sqlite|prisma|mongoose|drizzle|knex|@aws-sdk|@vercel\/blob|stripe|rate-limiter|helmet/i,
    );
    const files = (await sourceFiles("src")).filter((path) =>
      /\.(ts|tsx)$/.test(path),
    );
    for (const path of files) {
      const text = await readFile(path, "utf8");
      expect(text).not.toMatch(/from ["'](pg|better-sqlite3|prisma|@aws-sdk)/);
      if (
        path.includes(`${join("src", "app")}`) ||
        path.includes(`${join("src", "components")}`)
      )
        expect(text).not.toMatch(/setInterval|WebSocket|EventSource/);
    }
  });

  it("keeps the future capability seam inactive", async () => {
    const worker = await readFile("src/worker/cli.ts", "utf8");
    const capabilities = await readFile("src/shared/capabilities.ts", "utf8");
    expect(worker).not.toContain("capabilities");
    expect(capabilities).toContain("readonly enabled: false");
    expect(capabilities).not.toMatch(
      /tool_choice|export function|export class/,
    );
  });
});
