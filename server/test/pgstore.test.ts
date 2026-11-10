// Runs only when TEST_DATABASE_URL points at a Postgres (CI provides one; locally use docker compose).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { newShaderId } from '../src/app.js';
import { migrate } from '../src/migrations.js';
import { PgStore, type PageKey } from '../src/store.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgStore', () => {
  let store: PgStore;
  let pool: pg.Pool;
  beforeAll(async () => {
    store = await PgStore.connect(url!); // runs migrations
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  it('round-trips a document state, title and updated_at', async () => {
    const id = newShaderId();
    await store.create(id, new Uint8Array([1, 2, 3]));
    expect(await store.exists(id)).toBe(true);
    expect(Array.from((await store.loadState(id))!)).toEqual([1, 2, 3]);
    const before = (await store.meta(id))!;
    expect(before.title).toBe('Untitled');
    await new Promise((r) => setTimeout(r, 10));
    await store.saveState(id, new Uint8Array([9, 9]), '  My   shader ');
    const after = (await store.meta(id))!;
    expect(Array.from((await store.loadState(id))!)).toEqual([9, 9]);
    expect(after.title).toBe('My shader');
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it('records forked_from', async () => {
    const a = newShaderId();
    const b = newShaderId();
    await store.create(a, new Uint8Array([1]));
    await store.create(b, new Uint8Array([1]), { title: 'Fork of x', forkedFrom: a });
    expect((await store.meta(b))!.forkedFrom).toBe(a);
  });

  it('returns null for unknown ids', async () => {
    expect(await store.loadState('ZZZZZZZZZZ')).toBeNull();
    expect(await store.meta('ZZZZZZZZZZ')).toBeNull();
  });

  it('re-running migrations is a no-op', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('paginates without repeats or gaps when rows share the exact same timestamp', async () => {
    // Five rows with an identical microsecond timestamp far in the future (so they sort first),
    // plus one a microsecond earlier. Only the id tiebreak and a full-precision cursor keep pages
    // from repeating or skipping rows here.
    const same = '2100-01-01 00:00:00.123456+00';
    const ids = Array.from({ length: 5 }, () => newShaderId());
    const older = newShaderId();
    for (const id of ids)
      await pool.query(`INSERT INTO shaders (id, ydoc_state, created_at) VALUES ($1, '\\x00', $2)`, [id, same]);
    await pool.query(`INSERT INTO shaders (id, ydoc_state, created_at) VALUES ($1, '\\x00', '2100-01-01 00:00:00.123455+00')`, [older]);
    try {
      const seen: string[] = [];
      let after: PageKey | null = null;
      for (let i = 0; i < 3; i++) {
        const page = await store.list(2, after);
        seen.push(...page.items.map((x) => x.id));
        after = page.next;
      }
      const expected = [...ids].sort().reverse().concat(older); // id DESC within the tie, then the older row
      expect(seen).toEqual(expected);
    } finally {
      await pool.query('DELETE FROM shaders WHERE id = ANY($1)', [[...ids, older]]);
    }
  });

  it('uses the gallery index for the paginated query', async () => {
    // EXPLAIN without ANALYZE: just check the plan reads the composite index rather than sorting.
    await pool.query('SET enable_seqscan = off');
    const plan = (
      await pool.query(
        `EXPLAIN SELECT id FROM shaders WHERE (created_at, id) < ('2100-01-01'::timestamptz, 'zzzzzzzzzz')
         ORDER BY created_at DESC, id DESC LIMIT 21`,
      )
    ).rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
    await pool.query('RESET enable_seqscan');
    expect(plan).toContain('shaders_created_at_id');
    expect(plan).not.toMatch(/\bSort\b/);
  });
});
