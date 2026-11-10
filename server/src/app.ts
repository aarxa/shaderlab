// HTTP API + WebSocket upgrade. Kept separate from index.ts so tests can start it on a random port.
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { customAlphabet } from 'nanoid';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';

import { RoomManager, initialState } from './collab.js';
import * as metrics from './metrics.js';
import { registry } from './metrics.js';
import client from 'prom-client';
import { cleanTitle, type PageKey, type Store } from './store.js';
import { THUMB_MAX_BYTES, THUMB_TYPES, WriteLimiter, checkThumbnail } from './thumbnails.js';

// 10 chars from a 56-symbol alphabet (no look-alikes): ~58 bits, unguessable enough for share links.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const newShaderId = customAlphabet(ALPHABET, 10);
const ID_RE = /^[23456789A-HJ-NP-Za-km-z]{10}$/;

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

// Gallery cursors are opaque to clients: base64url of [createdKey, id]. Opaque means we can change
// the format later without breaking anyone, and clients can't build "page 7" by hand.
function encodeCursor(k: PageKey): string {
  return Buffer.from(JSON.stringify([k.t, k.id])).toString('base64url');
}
function decodeCursor(raw: string): PageKey | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [t, id] = v;
    if (typeof t !== 'string' || typeof id !== 'string') return null;
    if (!ID_RE.test(id) || !/^[0-9TZ:.+\- #]{10,40}$/.test(t)) return null;
    return { t, id };
  } catch {
    return null;
  }
}

/** Reads a shader's code and title: from the live room if someone has it open, else from storage. */
async function readSource(rooms: RoomManager, store: Store, id: string) {
  const live = await rooms.snapshot(id);
  const state = live?.state ?? (await store.loadState(id));
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const code = doc.getText('code').toString();
  doc.destroy();
  const title = live?.title ?? (await store.meta(id))?.title ?? 'Untitled';
  return { code, title };
}

export interface AppOptions {
  store: Store;
  staticDir?: string;
  persistDebounceMs?: number;
  /** How often to ping WebSocket clients; a client that hasn't answered the previous ping is dropped. */
  heartbeatMs?: number;
  /** Disconnect a client once this many bytes are queued for it (see RoomOptions). */
  maxBufferedBytes?: number;
  /**
   * Admission control: refuse new WebSocket connections (503, Retry-After) once this many are open.
   * Default from the M5 load test: on 1 CPU / 512 MB, 1000 continuously typing editors still had
   * p99 < 200 ms, and 2000 overloaded the CPU until garbage collection couldn't keep up and the
   * heap ran out. Refusing extra users keeps the ones already connected working.
   */
  maxConnections?: number;
  /** Minimum time between stored thumbnail writes for one shader (default 10 s). */
  thumbnailIntervalMs?: number;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  const rooms = new RoomManager(opts.store, {
    persistDebounceMs: opts.persistDebounceMs ?? 1000,
    maxBufferedBytes: opts.maxBufferedBytes,
  });

  app.get('/api/health', async () => ({ ok: true, liveRooms: rooms.liveRooms }));

  // Prometheus metrics. Set METRICS_TOKEN to require "Authorization: Bearer <token>" in production.
  app.get('/metrics', async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send('unauthorized');
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.post('/api/shaders', async (_req, reply) => {
    const id = newShaderId();
    await opts.store.create(id, initialState());
    reply.code(201);
    return { id };
  });

  // Gallery: newest first, cursor-paginated. ?limit=1..50 (default 20), ?cursor=<from nextCursor>.
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/shaders', async (req, reply) => {
    const n = Number.parseInt(req.query.limit ?? '', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), PAGE_MAX) : PAGE_DEFAULT;
    let after: PageKey | null = null;
    if (req.query.cursor !== undefined) {
      after = decodeCursor(req.query.cursor);
      if (!after) return reply.code(400).send({ error: 'bad cursor' });
    }
    try {
      const page = await opts.store.list(limit, after);
      return { items: page.items, nextCursor: page.next ? encodeCursor(page.next) : null };
    } catch (err) {
      // A well-formed but impossible timestamp makes Postgres raise a data exception (class 22).
      if (String((err as { code?: string }).code ?? '').startsWith('22')) return reply.code(400).send({ error: 'bad cursor' });
      throw err;
    }
  });

  // Fork: a new shader starting from the original's current code, linked back to it.
  app.post<{ Params: { id: string } }>('/api/shaders/:id/fork', async (req, reply) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad id' });
    const source = await readSource(rooms, opts.store, id);
    if (!source) return reply.code(404).send({ error: 'not found' });
    // A fresh document with a copy of the text, rather than a copy of the original's CRDT state:
    // the state carries the whole edit history (deleted text is kept as tombstones), which every
    // fork-of-a-fork would inherit. The fork's own history starts here.
    const title = cleanTitle(`Fork of ${source.title}`);
    const doc = new Y.Doc();
    doc.getText('code').insert(0, source.code);
    doc.getMap('meta').set('title', title);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const newId = newShaderId();
    await opts.store.create(newId, state, { title, forkedFrom: id });
    // Same code, so the same picture, until someone edits the fork and a new one is captured.
    await opts.store.copyThumbnail(id, newId);
    reply.code(201);
    return { id: newId };
  });

  app.get<{ Params: { id: string } }>('/api/shaders/:id', async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const meta = await opts.store.meta(req.params.id);
    if (!meta) return reply.code(404).send({ error: 'not found' });
    return meta;
  });

  // Thumbnails. The browser of whoever is editing captures the live preview and uploads it here.
  // Raw image body (not JSON or multipart): the parser hands the route a Buffer.
  app.addContentTypeParser([...THUMB_TYPES], { parseAs: 'buffer', bodyLimit: THUMB_MAX_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  const thumbLimiter = new WriteLimiter(opts.thumbnailIntervalMs ?? 10_000);

  app.put<{ Params: { id: string }; Body: Buffer }>('/api/shaders/:id/thumbnail', async (req, reply) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad id' });
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: `send ${THUMB_TYPES.join(', ')}` });
    const checked = checkThumbnail(req.body);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    // Checked after validation, so a rejected upload doesn't use up the shader's write slot.
    const waitMs = thumbLimiter.take(id);
    if (waitMs > 0) {
      reply.header('Retry-After', String(Math.ceil(waitMs / 1000)));
      return reply.code(429).send({ error: 'thumbnail updated too recently' });
    }
    // Stored as the type found in the bytes, not the one the client declared.
    if (!(await opts.store.saveThumbnail(id, req.body, checked.info.type))) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/shaders/:id/thumbnail', async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const thumb = await opts.store.loadThumbnail(req.params.id);
    if (!thumb) return reply.code(404).send({ error: 'no thumbnail' });
    const etag = `"${thumb.updatedAt.getTime()}"`;
    reply
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      // The gallery asks for ?v=<thumbnailAt>, a URL that only ever means one image, so the browser
      // may keep it forever. Without ?v (or with a stale one) it must revalidate with the ETag.
      .header(
        'Cache-Control',
        req.query.v === String(thumb.updatedAt.getTime()) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(thumb.contentType).send(Buffer.from(thumb.image));
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: opts.staticDir });
    // Client-side routes (/s/:id) all serve the single-page app.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  // WebSocket endpoint: /collab/<shaderId>. y-websocket clients append the room name to the URL.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const maxConnections = opts.maxConnections ?? Number(process.env.MAX_CONNECTIONS ?? 1000);
  // Total bytes queued for clients but not yet written to the network, summed when scraped.
  if (!registry.getSingleMetric('shaderlab_send_buffer_bytes')) {
    new client.Gauge({
      name: 'shaderlab_send_buffer_bytes',
      help: 'Bytes queued for all clients but not yet written to the network',
      registers: [registry],
      collect() {
        let total = 0;
        for (const ws of wss.clients) total += ws.bufferedAmount;
        this.set(total);
      },
    });
  }
  app.server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (wss.clients.size >= maxConnections) {
      metrics.connectionsRejected.inc();
      socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const match = /^\/collab\/([^/?]+)/.exec(req.url ?? '');
    const id = match?.[1];
    if (!id || !ID_RE.test(id) || !(await opts.store.exists(id))) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      void rooms.join(id, ws);
    });
  });

  // Heartbeat. A client that vanishes without closing its TCP connection (laptop lid shut, phone
  // out of signal, a proxy that keeps half-open connections) would otherwise stay "connected"
  // forever: its cursor never leaves the room, the room never unloads, and memory leaks. Every
  // interval we ping each client; anyone who didn't answer the previous ping is terminated, which
  // fires the normal close path (presence removed, room saved and unloaded).
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  // Close WebSockets in preClose, not onClose: app.close() waits for the HTTP server to finish,
  // which waits for every open connection, upgraded WebSockets included, before onClose runs. A
  // silent client would make shutdown hang until the platform SIGKILLs us, losing unsaved edits.
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    for (const client of wss.clients) client.terminate();
  });

  app.addHook('onClose', async () => {
    await rooms.flushAll(); // save anything still in memory
    wss.close();
  });

  return { app, rooms };
}
