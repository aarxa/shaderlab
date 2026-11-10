// Runs only when TEST_DATABASE_URL points at a Postgres (CI provides one; locally use docker compose).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newShaderId } from '../src/app.js';
import { PgStore } from '../src/store.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgStore', () => {
  let store: PgStore;
  beforeAll(async () => {
    store = await PgStore.connect(url!);
  });
  afterAll(async () => {
    await store?.close();
  });

  it('round-trips a document state and tracks updated_at', async () => {
    const id = newShaderId();
    await store.create(id, new Uint8Array([1, 2, 3]));
    expect(await store.exists(id)).toBe(true);
    expect(Array.from((await store.loadState(id))!)).toEqual([1, 2, 3]);
    const before = (await store.meta(id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await store.saveState(id, new Uint8Array([9, 9]));
    expect(Array.from((await store.loadState(id))!)).toEqual([9, 9]);
    expect((await store.meta(id))!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('returns null for unknown ids', async () => {
    expect(await store.loadState('ZZZZZZZZZZ')).toBeNull();
    expect(await store.meta('ZZZZZZZZZZ')).toBeNull();
  });
});
