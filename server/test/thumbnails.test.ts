// Thumbnails: upload validation, caching, rate limiting, and fork copies. The HTTP tests run against
// MemoryStore, and against Postgres too when TEST_DATABASE_URL is set.
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { MemoryStore, PgStore, type Store } from '../src/store.js';
import { THUMB_MAX_BYTES, WriteLimiter, sniffImage } from '../src/thumbnails.js';

// ---- Test images -------------------------------------------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real, decodable PNG: w×h, solid color. */
function png(w: number, h: number, rgb = [200, 80, 40]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, no filter, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Header bytes of each WebP flavor (enough for sniffing; not a decodable picture). */
function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(kind, 12, 'ascii');
  if (kind === 'VP8 ') {
    b.set([0x9d, 0x01, 0x2a], 23); // start code
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f; // signature
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}
/** JPEG header: SOI, an APP0 segment to skip over, then SOF0 with the size. */
function jpeg(w: number, h: number) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

// ---- Unit tests --------------------------------------------------------------------------------

describe('sniffImage', () => {
  it('reads type and size from PNG, JPEG, and all three WebP layouts', () => {
    expect(sniffImage(png(320, 180))).toEqual({ type: 'image/png', width: 320, height: 180 });
    expect(sniffImage(jpeg(320, 180))).toEqual({ type: 'image/jpeg', width: 320, height: 180 });
    for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) {
      expect(sniffImage(webp(kind, 320, 180))).toEqual({ type: 'image/webp', width: 320, height: 180 });
    }
  });

  it('rejects anything else, including HTML and truncated headers', () => {
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImage(png(320, 180).subarray(0, 16))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('WriteLimiter', () => {
  it('allows one write per key per interval', () => {
    const l = new WriteLimiter(10_000);
    expect(l.take('a', 0)).toBe(0);
    expect(l.take('a', 4_000)).toBe(6_000);
    expect(l.take('b', 4_000)).toBe(0); // other shaders unaffected
    expect(l.take('a', 10_000)).toBe(0);
  });
});

// ---- HTTP tests, per store ---------------------------------------------------------------------

const url = process.env.TEST_DATABASE_URL;
const stores: Array<[string, () => Promise<Store>]> = [['MemoryStore', async () => new MemoryStore()]];
if (url) stores.push(['PgStore', () => PgStore.connect(url)]);

describe.each(stores)('thumbnail API (%s)', (_name, makeStore) => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let base: string;
  beforeAll(async () => {
    const store = await makeStore();
    ({ app } = await buildApp({ store, thumbnailIntervalMs: 200 }));
    app.addHook('onClose', () => store.close());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => app.close());

  const create = async () =>
    ((await (await fetch(`${base}/api/shaders`, { method: 'POST' })).json()) as { id: string }).id;
  const put = (id: string, body: Buffer, type = 'image/png') =>
    fetch(`${base}/api/shaders/${id}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': type }, body });
  const meta = async (id: string) =>
    (await (await fetch(`${base}/api/shaders/${id}`)).json()) as { thumbnailAt: string | null };

  it('stores an upload and serves it back with safe headers', async () => {
    const id = await create();
    expect((await meta(id)).thumbnailAt).toBeNull();
    const image = png(320, 180);
    expect((await put(id, image)).status).toBe(204);

    const res = await fetch(`${base}/api/shaders/${id}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);
  });

  it('stores the type found in the bytes, not the declared one', async () => {
    const id = await create();
    expect((await put(id, webp('VP8 ', 320, 180), 'image/png')).status).toBe(204);
    const res = await fetch(`${base}/api/shaders/${id}/thumbnail`);
    expect(res.headers.get('content-type')).toBe('image/webp');
  });

  it('caches a versioned URL forever and revalidates the bare one with an ETag', async () => {
    const id = await create();
    await put(id, png(320, 180));
    const v = new Date((await meta(id)).thumbnailAt!).getTime();

    const versioned = await fetch(`${base}/api/shaders/${id}/thumbnail?v=${v}`);
    expect(versioned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const bare = await fetch(`${base}/api/shaders/${id}/thumbnail`);
    expect(bare.headers.get('cache-control')).toBe('no-cache');
    const etag = bare.headers.get('etag')!;
    const again = await fetch(`${base}/api/shaders/${id}/thumbnail`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);

    // A new upload changes the version, so the old ETag and the old ?v no longer match.
    await new Promise((r) => setTimeout(r, 250));
    expect((await put(id, png(320, 180, [10, 200, 90]))).status).toBe(204);
    const v2 = new Date((await meta(id)).thumbnailAt!).getTime();
    expect(v2).toBeGreaterThan(v);
    expect((await fetch(`${base}/api/shaders/${id}/thumbnail`, { headers: { 'If-None-Match': etag } })).status).toBe(200);
    const stale = await fetch(`${base}/api/shaders/${id}/thumbnail?v=${v}`);
    expect(stale.headers.get('cache-control')).toBe('no-cache');
  });

  it('rejects uploads that are not small images', async () => {
    const id = await create();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await put(id, html, 'image/png')).status).toBe(400); // lies about its type
    expect((await put(id, png(2000, 100))).status).toBe(400); // too many pixels
    expect((await put(id, Buffer.alloc(THUMB_MAX_BYTES + 1, 1))).status).toBe(413); // too many bytes
    expect((await put(id, Buffer.from('{}'), 'application/json')).status).toBe(415);
    expect((await put(id, png(32, 32), 'text/html')).status).toBe(415);
    expect((await meta(id)).thumbnailAt).toBeNull(); // none of them were stored
  });

  it('limits how often one shader can be updated', async () => {
    const id = await create();
    expect((await put(id, png(32, 32))).status).toBe(204);
    const second = await put(id, png(32, 32));
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 250));
    expect((await put(id, png(32, 32))).status).toBe(204);
  });

  it('404s for unknown shaders and 400s for malformed ids', async () => {
    expect((await put('ZZZZZZZZZZ', png(32, 32))).status).toBe(404);
    expect((await fetch(`${base}/api/shaders/ZZZZZZZZZZ/thumbnail`)).status).toBe(404);
    expect((await fetch(`${base}/api/shaders/nope/thumbnail`)).status).toBe(400);
  });

  it('lists thumbnailAt in the gallery and copies the thumbnail to forks', async () => {
    const id = await create();
    const image = png(64, 36, [1, 2, 3]);
    await put(id, image);
    const page = (await (await fetch(`${base}/api/shaders?limit=50`)).json()) as {
      items: Array<{ id: string; thumbnailAt: string | null }>;
    };
    expect(page.items.find((i) => i.id === id)?.thumbnailAt).toBeTruthy();

    const fork = ((await (await fetch(`${base}/api/shaders/${id}/fork`, { method: 'POST' })).json()) as { id: string }).id;
    expect((await meta(fork)).thumbnailAt).toBeTruthy();
    const res = await fetch(`${base}/api/shaders/${fork}/thumbnail`);
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);
  });
});
