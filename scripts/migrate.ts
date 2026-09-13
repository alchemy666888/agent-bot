import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { parseDatabaseConfig } from '../src/modules/config/env'

async function main() {
  const config = parseDatabaseConfig(process.env)
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  })
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
    process.stdout.write('Database migrations completed.\n')
  } finally {
    await pool.end()
  }
}

main().catch(() => {
  process.stderr.write('Database migration failed.\n')
  process.exitCode = 1
})
