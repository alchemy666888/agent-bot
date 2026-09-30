import { z } from "zod";

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^postgres(ql)?$/ })),
});

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
