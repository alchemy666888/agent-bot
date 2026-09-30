import { Pool, type PoolConfig } from "pg";
import { assertPersistencePath } from "./paths";
import type { PersistenceStore } from "./store";

const TABLE = "telegram_agent_files";

export function createPostgresStore(
  connectionString: string,
  certificateAuthority?: string,
): PersistenceStore {
  return new PostgresStore(
    new Pool(postgresPoolConfig(connectionString, certificateAuthority)),
  );
}

/** Builds a TLS configuration without allowing URL SSL options to replace the CA. */
export function postgresPoolConfig(
  connectionString: string,
  certificateAuthority?: string,
): PoolConfig {
  if (!certificateAuthority)
    return { connectionString, max: 3, allowExitOnIdle: true };

  const url = new URL(connectionString);
  // node-postgres replaces an explicit `ssl` object when SSL query parameters
  // are also present, which would silently discard the Aiven CA.
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(parameter);
  return {
    connectionString: url.toString(),
    max: 3,
    allowExitOnIdle: true,
    ssl: { ca: certificateAuthority, rejectUnauthorized: true },
  };
}

class PostgresStore implements PersistenceStore {
  private initialized?: Promise<void>;
  constructor(private readonly pool: Pool) {}

  private initialize(): Promise<void> {
    return (this.initialized ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (path text PRIMARY KEY, content bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
      )
      .then(() => undefined));
  }

  async listFiles(prefixes: string[]): Promise<{ relativePath: string }[]> {
    await this.initialize();
    if (prefixes.length === 0) return [];
    const clauses = prefixes
      .map((_, index) => `path LIKE $${index + 1}`)
      .join(" OR ");
    const result = await this.pool.query<{ path: string }>(
      `SELECT path FROM ${TABLE} WHERE ${clauses} ORDER BY path`,
      prefixes.map((prefix) => `${prefix}%`),
    );
    return result.rows.map(({ path }) => ({ relativePath: path }));
  }

  async download(relativePath: string): Promise<Buffer> {
    assertPersistencePath(relativePath);
    await this.initialize();
    const result = await this.pool.query<{ content: Buffer }>(
      `SELECT content FROM ${TABLE} WHERE path = $1`,
      [relativePath],
    );
    if (!result.rows[0])
      throw Object.assign(new Error("PERSISTENCE_RECORD_NOT_FOUND"), {
        status: 404,
      });
    return Buffer.from(result.rows[0].content);
  }

  async upload(relativePath: string, body: Buffer): Promise<void> {
    assertPersistencePath(relativePath);
    await this.initialize();
    await this.pool.query(
      `INSERT INTO ${TABLE} (path, content) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [relativePath, body],
    );
  }

  async delete(relativePath: string): Promise<void> {
    assertPersistencePath(relativePath);
    await this.initialize();
    await this.pool.query(`DELETE FROM ${TABLE} WHERE path = $1`, [
      relativePath,
    ]);
  }
}
