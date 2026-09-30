import { z } from "zod";

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^postgres(ql)?$/ }))
    .transform(normalizePostgresUrl),
});

/**
 * Keep node-postgres on its current, strict TLS behavior without relying on
 * sslmode aliases whose meaning changes in pg v9.
 */
function normalizePostgresUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
  const usesLibpqCompatibility =
    url.searchParams.get("uselibpqcompat")?.toLowerCase() === "true";
  if (
    !usesLibpqCompatibility &&
    ["prefer", "require", "verify-ca"].includes(sslmode ?? "")
  )
    url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export type DatabaseConfig = z.infer<typeof databaseSchema>;

export function readDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  return databaseSchema.parse(env);
}

/** Passes only the database connection string to the sandbox worker. */
export function databaseProcessEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return readDatabaseConfig(env);
}
