// Storage for shaders. A shader's code lives in a Yjs document; we persist the document's full
// encoded state (a compact binary CRDT snapshot) plus a little metadata.
import pg from 'pg';

export interface ShaderMeta {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Store {
  create(id: string, initialState: Uint8Array): Promise<void>;
  exists(id: string): Promise<boolean>;
  loadState(id: string): Promise<Uint8Array | null>;
  saveState(id: string, state: Uint8Array): Promise<void>;
  meta(id: string): Promise<ShaderMeta | null>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  private rows = new Map<string, { state: Uint8Array; meta: ShaderMeta }>();

  async create(id: string, initialState: Uint8Array) {
    const now = new Date();
    this.rows.set(id, { state: initialState, meta: { id, createdAt: now, updatedAt: now } });
  }
  async exists(id: string) {
    return this.rows.has(id);
  }
  async loadState(id: string) {
    return this.rows.get(id)?.state ?? null;
  }
  async saveState(id: string, state: Uint8Array) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no shader ${id}`);
    row.state = state;
    row.meta.updatedAt = new Date();
  }
  async meta(id: string) {
    return this.rows.get(id)?.meta ?? null;
  }
  async close() {}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shaders (
  id          TEXT PRIMARY KEY,
  ydoc_state  BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

export class PgStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query(SCHEMA);
    return new PgStore(pool);
  }

  async create(id: string, initialState: Uint8Array) {
    await this.pool.query('INSERT INTO shaders (id, ydoc_state) VALUES ($1, $2)', [id, Buffer.from(initialState)]);
  }
  async exists(id: string) {
    const r = await this.pool.query('SELECT 1 FROM shaders WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async loadState(id: string) {
    const r = await this.pool.query<{ ydoc_state: Buffer }>('SELECT ydoc_state FROM shaders WHERE id = $1', [id]);
    return r.rows[0] ? new Uint8Array(r.rows[0].ydoc_state) : null;
  }
  async saveState(id: string, state: Uint8Array) {
    await this.pool.query('UPDATE shaders SET ydoc_state = $2, updated_at = now() WHERE id = $1', [id, Buffer.from(state)]);
  }
  async meta(id: string) {
    const r = await this.pool.query<{ id: string; created_at: Date; updated_at: Date }>(
      'SELECT id, created_at, updated_at FROM shaders WHERE id = $1',
      [id],
    );
    const row = r.rows[0];
    return row ? { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  async close() {
    await this.pool.end();
  }
}
