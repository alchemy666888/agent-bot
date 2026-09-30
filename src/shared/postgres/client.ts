import { Pool } from "pg";
import { assertPersistencePath } from "./paths";
import type { PersistenceStore } from "./store";

const TABLE = "telegram_agent_files";

export function createPostgresStore(
  connectionString: string,
): PersistenceStore {
  return new PostgresStore(
    new Pool({ connectionString, max: 3, allowExitOnIdle: true }),
  );
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
