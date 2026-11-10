// Database migrations: numbered, append-only schema changes, applied once each, in order.
//
// The SQL lives in this file (not in .sql files) so it is compiled into dist/ and can't be left out
// of the Docker image. Never edit a migration that has shipped; add a new one instead.
import type pg from 'pg';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create shaders',
    // IF NOT EXISTS: databases created before migrations existed (like the live one) already have it.
    sql: `
      CREATE TABLE IF NOT EXISTS shaders (
        id          TEXT PRIMARY KEY,
        ydoc_state  BYTEA NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );`,
  },
  {
    version: 2,
    name: 'title and forked_from',
    sql: `
      ALTER TABLE shaders ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled';
      ALTER TABLE shaders ADD COLUMN forked_from TEXT REFERENCES shaders(id) ON DELETE SET NULL;`,
  },
  {
    version: 3,
    name: 'gallery index',
    // Matches the gallery query's ORDER BY exactly, so Postgres can walk the index instead of sorting.
    sql: `CREATE INDEX shaders_created_at_id ON shaders (created_at DESC, id DESC);`,
  },
  {
    version: 4,
    name: 'thumbnails',
    // A separate table, not a column on shaders: the gallery list and room loads never read image
    // bytes they don't need, and a thumbnail upload doesn't rewrite the (larger) document row.
    sql: `
      CREATE TABLE thumbnails (
        shader_id     TEXT PRIMARY KEY REFERENCES shaders(id) ON DELETE CASCADE,
        image         BYTEA NOT NULL,
        content_type  TEXT NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );`,
  },
];

// Arbitrary constant: every server instance asks for the same advisory lock number.
const LOCK_ID = 727_001;

/** Applies every migration the database hasn't seen yet. Safe to call from many processes at once. */
export async function migrate(pool: pg.Pool, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    // Two server instances starting together would otherwise both try to apply migration N.
    // pg_advisory_lock blocks the second one until the first has finished.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INT PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      // One transaction per migration: if any statement fails, none of it is applied and it is not
      // recorded, so the next start retries it from a clean state. (Postgres DDL is transactional.)
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
        applied.push(m.version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
