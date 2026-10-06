import { z } from "zod";

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^postgres(ql)?$/ }))
    .transform(normalizePostgresUrl),
  AIVEN_PG_CA: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) =>
      value === undefined ? undefined : normalizeCertificate(value),
    ),
});

/**
 * Keep node-postgres on its current, strict TLS behavior without relying on
 * sslmode aliases whose meaning changes in pg v9.
 */
/**
 * Vercel stores pasted PEMs with literal "\n", and a real multiline value
 * cannot travel in a sandbox command environment without splitting later
 * variables. Callers that forward this to the worker base64-encode it.
 */
export function normalizeCertificate(value: string): string {
  const expanded = value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  const trimmed = expanded.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN CERTIFICATE")) return decoded;
  return trimmed;
}

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

/**
 * Passes the database settings the sandbox worker needs. The CA is a single
 * line so a PEM cannot split the command environment and hide the bot token
 * and model credentials from the worker.
 */
export function databaseProcessEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const config = readDatabaseConfig(env);
  return {
    DATABASE_URL: config.DATABASE_URL,
    ...(config.AIVEN_PG_CA
      ? {
          AIVEN_PG_CA: Buffer.from(config.AIVEN_PG_CA, "utf8").toString(
            "base64",
          ),
        }
      : {}),
  };
}
