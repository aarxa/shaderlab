// HTTP API + WebSocket upgrade. Kept separate from index.ts so tests can start it on a random port.
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { customAlphabet } from 'nanoid';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';

import { RoomManager, initialState } from './collab.js';
import { cleanTitle, type PageKey, type Store } from './store.js';

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
  logger?: boolean;
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  const rooms = new RoomManager(opts.store, { persistDebounceMs: opts.persistDebounceMs ?? 1000 });

  app.get('/api/health', async () => ({ ok: true, liveRooms: rooms.liveRooms }));

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
    reply.code(201);
    return { id: newId };
  });

  app.get<{ Params: { id: string } }>('/api/shaders/:id', async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const meta = await opts.store.meta(req.params.id);
    if (!meta) return reply.code(404).send({ error: 'not found' });
    return meta;
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
  app.server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/collab\/([^/?]+)/.exec(req.url ?? '');
    const id = match?.[1];
    if (!id || !ID_RE.test(id) || !(await opts.store.exists(id))) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void rooms.join(id, ws);
    });
  });

  app.addHook('onClose', async () => {
    for (const client of wss.clients) client.terminate();
    await rooms.flushAll();
    wss.close();
  });

  return { app, rooms };
}
