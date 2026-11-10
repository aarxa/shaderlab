// Storage for shaders. A shader's code lives in a Yjs document; we persist the document's full
// encoded state (a compact binary CRDT snapshot) plus metadata the gallery can query.
import pg from 'pg';

import { migrate } from './migrations.js';

export interface ShaderMeta {
  id: string;
  title: string;
  forkedFrom: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When the thumbnail was last replaced, or null if there is none yet. */
  thumbnailAt: Date | null;
}

export interface Thumbnail {
  image: Uint8Array;
  contentType: string;
  updatedAt: Date;
}

export interface CreateOptions {
  title?: string;
  forkedFrom?: string | null;
}

/**
 * Position in the gallery order (newest first). `t` is the row's created_at exactly as the store
 * keeps it: for Postgres that is the timestamp's text form with full microsecond precision. A JS Date
 * only has milliseconds, so a cursor built from one would sit slightly *before* the real value and the
 * next page would repeat that row.
 */
export interface PageKey {
  t: string;
  id: string;
}

export interface Page {
  items: ShaderMeta[];
  next: PageKey | null;
}

export interface Store {
  create(id: string, initialState: Uint8Array, opts?: CreateOptions): Promise<void>;
  exists(id: string): Promise<boolean>;
  loadState(id: string): Promise<Uint8Array | null>;
  saveState(id: string, state: Uint8Array, title: string): Promise<void>;
  meta(id: string): Promise<ShaderMeta | null>;
  /** Newest first, starting after `after` (exclusive). */
  list(limit: number, after?: PageKey | null): Promise<Page>;
  /** Insert or replace. Returns false if the shader doesn't exist. */
  saveThumbnail(id: string, image: Uint8Array, contentType: string): Promise<boolean>;
  loadThumbnail(id: string): Promise<Thumbnail | null>;
  /** Fork support: give `to` a copy of `from`'s thumbnail, if it has one. */
  copyThumbnail(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

export const TITLE_MAX = 80;
export const DEFAULT_TITLE = 'Untitled';

/** Server-side title rules: a string, trimmed, at most TITLE_MAX characters, never empty. */
export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TITLE;
  // Array.from splits by code point, so we never cut an emoji in half.
  const t = Array.from(value.trim().replace(/\s+/g, ' ')).slice(0, TITLE_MAX).join('');
  return t || DEFAULT_TITLE;
}

interface MemRow {
  state: Uint8Array;
  meta: ShaderMeta;
  key: string; // ISO time + sequence, so rows created in the same millisecond still have an order
}

export class MemoryStore implements Store {
  private rows = new Map<string, MemRow>();
  private thumbs = new Map<string, Thumbnail>();
  private seq = 0;
  private withThumb = (m: ShaderMeta): ShaderMeta => ({ ...m, thumbnailAt: this.thumbs.get(m.id)?.updatedAt ?? null });

  async create(id: string, initialState: Uint8Array, opts: CreateOptions = {}) {
    const now = new Date();
    const key = `${now.toISOString()}#${String(this.seq++).padStart(9, '0')}`;
    this.rows.set(id, {
      state: initialState,
      key,
      meta: { id, title: cleanTitle(opts.title), forkedFrom: opts.forkedFrom ?? null, createdAt: now, updatedAt: now, thumbnailAt: null },
    });
  }
  async exists(id: string) {
    return this.rows.has(id);
  }
  async loadState(id: string) {
    return this.rows.get(id)?.state ?? null;
  }
  async saveState(id: string, state: Uint8Array, title: string) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no shader ${id}`);
    row.state = state;
    row.meta = { ...row.meta, title: cleanTitle(title), updatedAt: new Date() };
  }
  async meta(id: string) {
    const row = this.rows.get(id);
    return row ? this.withThumb(row.meta) : null;
  }
  async list(limit: number, after: PageKey | null = null): Promise<Page> {
    const before = (r: MemRow, k: PageKey) => r.key < k.t || (r.key === k.t && r.meta.id < k.id);
    const sorted = [...this.rows.values()]
      .filter((r) => !after || before(r, after))
      .sort((a, b) => (a.key === b.key ? (a.meta.id < b.meta.id ? 1 : -1) : a.key < b.key ? 1 : -1));
    const page = sorted.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.withThumb(r.meta)),
      next: sorted.length > limit && last ? { t: last.key, id: last.meta.id } : null,
    };
  }
  async saveThumbnail(id: string, image: Uint8Array, contentType: string) {
    if (!this.rows.has(id)) return false;
    const prev = this.thumbs.get(id)?.updatedAt.getTime() ?? 0;
    // Strictly increasing, so the gallery's ?v= cache key always changes when the image does.
    this.thumbs.set(id, { image, contentType, updatedAt: new Date(Math.max(Date.now(), prev + 1)) });
    return true;
  }
  async loadThumbnail(id: string) {
    return this.thumbs.get(id) ?? null;
  }
  async copyThumbnail(from: string, to: string) {
    const t = this.thumbs.get(from);
    if (t && this.rows.has(to)) this.thumbs.set(to, { ...t, updatedAt: new Date() });
  }
  async close() {}
}

interface PgRow {
  id: string;
  title: string;
  forked_from: string | null;
  created_at: Date;
  updated_at: Date;
  created_key: string;
  thumbnail_at: Date | null;
}
// LEFT JOIN on the thumbnails primary key: one index lookup per row, and the image bytes are not read.
const META_COLUMNS =
  's.id, s.title, s.forked_from, s.created_at, s.updated_at, s.created_at::text AS created_key, t.updated_at AS thumbnail_at';
const META_FROM = 'shaders s LEFT JOIN thumbnails t ON t.shader_id = s.id';
const toMeta = (r: PgRow): ShaderMeta => ({
  id: r.id,
  title: r.title,
  forkedFrom: r.forked_from,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  thumbnailAt: r.thumbnail_at,
});

export class PgStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await migrate(pool);
    return new PgStore(pool);
  }

  async create(id: string, initialState: Uint8Array, opts: CreateOptions = {}) {
    await this.pool.query('INSERT INTO shaders (id, ydoc_state, title, forked_from) VALUES ($1, $2, $3, $4)', [
      id,
      Buffer.from(initialState),
      cleanTitle(opts.title),
      opts.forkedFrom ?? null,
    ]);
  }
  async exists(id: string) {
    const r = await this.pool.query('SELECT 1 FROM shaders WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async loadState(id: string) {
    const r = await this.pool.query<{ ydoc_state: Buffer }>('SELECT ydoc_state FROM shaders WHERE id = $1', [id]);
    return r.rows[0] ? new Uint8Array(r.rows[0].ydoc_state) : null;
  }
  async saveState(id: string, state: Uint8Array, title: string) {
    await this.pool.query('UPDATE shaders SET ydoc_state = $2, title = $3, updated_at = now() WHERE id = $1', [
      id,
      Buffer.from(state),
      cleanTitle(title),
    ]);
  }
  async meta(id: string) {
    const r = await this.pool.query<PgRow>(`SELECT ${META_COLUMNS} FROM ${META_FROM} WHERE s.id = $1`, [id]);
    return r.rows[0] ? toMeta(r.rows[0]) : null;
  }
  async list(limit: number, after: PageKey | null = null): Promise<Page> {
    // Fetch one extra row to learn whether another page exists. Two separate queries rather than
    // "WHERE $1 IS NULL OR ...": the OR form can stop Postgres from using the index.
    // The row comparison (created_at, id) < (t, id) is exactly "comes after the cursor" in
    // ORDER BY created_at DESC, id DESC, and the composite index serves it directly.
    const r = after
      ? await this.pool.query<PgRow>(
          `SELECT ${META_COLUMNS} FROM ${META_FROM} WHERE (s.created_at, s.id) < ($1::timestamptz, $2)
           ORDER BY s.created_at DESC, s.id DESC LIMIT $3`,
          [after.t, after.id, limit + 1],
        )
      : await this.pool.query<PgRow>(
          `SELECT ${META_COLUMNS} FROM ${META_FROM} ORDER BY s.created_at DESC, s.id DESC LIMIT $1`,
          [limit + 1],
        );
    const rows = r.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toMeta),
      next: r.rows.length > limit && last ? { t: last.created_key, id: last.id } : null,
    };
  }
  async saveThumbnail(id: string, image: Uint8Array, contentType: string) {
    // INSERT ... SELECT FROM shaders: inserts nothing (rowCount 0) if the shader doesn't exist,
    // instead of raising a foreign-key error. GREATEST keeps updated_at strictly increasing.
    const r = await this.pool.query(
      `INSERT INTO thumbnails (shader_id, image, content_type)
       SELECT id, $2, $3 FROM shaders WHERE id = $1
       ON CONFLICT (shader_id) DO UPDATE SET image = EXCLUDED.image, content_type = EXCLUDED.content_type,
         updated_at = GREATEST(now(), thumbnails.updated_at + interval '1 millisecond')`,
      [id, Buffer.from(image), contentType],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async loadThumbnail(id: string) {
    const r = await this.pool.query<{ image: Buffer; content_type: string; updated_at: Date }>(
      'SELECT image, content_type, updated_at FROM thumbnails WHERE shader_id = $1',
      [id],
    );
    const row = r.rows[0];
    return row ? { image: new Uint8Array(row.image), contentType: row.content_type, updatedAt: row.updated_at } : null;
  }
  async copyThumbnail(from: string, to: string) {
    await this.pool.query(
      `INSERT INTO thumbnails (shader_id, image, content_type)
       SELECT $2, image, content_type FROM thumbnails WHERE shader_id = $1
       ON CONFLICT (shader_id) DO NOTHING`,
      [from, to],
    );
  }
  async close() {
    await this.pool.end();
  }
}
