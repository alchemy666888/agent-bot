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
  it("uses PostgreSQL without other stores, throttles, moderation, or tools", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    expect(names).toContain("pg");
    expect(names.join("\n")).not.toMatch(
      /sqlite|prisma|mongoose|drizzle|knex|googleapis|@aws-sdk|@vercel\/blob|stripe|rate-limiter|helmet/i,
    );
    const files = (await sourceFiles("src")).filter((path) =>
      /\.(ts|tsx)$/.test(path),
    );
    for (const path of files) {
      const text = await readFile(path, "utf8");
      expect(text).not.toMatch(
        /from ["'](better-sqlite3|prisma|googleapis|@aws-sdk)/,
      );
      if (
        path.includes(`${join("src", "app")}`) ||
        path.includes(`${join("src", "components")}`)
      )
        expect(text).not.toMatch(/setInterval|WebSocket|EventSource/);
    }
  });

  it("keeps capabilities behind the approved registry", async () => {
    const worker = await readFile("src/worker/cli.ts", "utf8");
    const capabilities = await readFile(
      "src/worker/capabilities/registry.ts",
      "utf8",
    );
    expect(worker).toContain("createCapabilityRegistry");
    expect(capabilities).toContain("CAPABILITY_DENIED");
    expect(capabilities).toContain("permitted.includes(id)");
  });

  it("keeps capability identifiers and adapters code-owned", async () => {
    const capabilities = await readFile("src/shared/capabilities.ts", "utf8");
    expect(capabilities).toContain("capabilityIdentifiers");
    expect(capabilities).toContain("capabilityIdentifierSchema");
    expect(capabilities).not.toMatch(/tool_choice|child_process|fetch\(/);
  });
});
