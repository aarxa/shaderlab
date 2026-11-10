// HTTP API + WebSocket upgrade. Kept separate from index.ts so tests can start it on a random port.
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { customAlphabet } from 'nanoid';
import { WebSocketServer } from 'ws';

import { RoomManager, initialState } from './collab.js';
import type { Store } from './store.js';

// 10 chars from a 56-symbol alphabet (no look-alikes): ~58 bits, unguessable enough for share links.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const newShaderId = customAlphabet(ALPHABET, 10);
const ID_RE = /^[23456789A-HJ-NP-Za-km-z]{10}$/;

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
