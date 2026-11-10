// Connection lifecycle: dead clients, and shutting down without losing edits. Both bugs were found
// by the M5 load test (a half-open connection left behind kept a room alive and hung shutdown).
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type StartOpts = { heartbeatMs?: number; persistDebounceMs?: number; maxBufferedBytes?: number; maxConnections?: number };

async function start(opts: StartOpts = {}) {
  const store = new MemoryStore();
  const { app, rooms } = await buildApp({ store, ...opts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const base = `127.0.0.1:${addr.port}`;
  let closed = false;
  cleanup.push(() => !closed && app.close());
  const create = async () =>
    ((await (await fetch(`http://${base}/api/shaders`, { method: 'POST' })).json()) as { id: string }).id;
  return { app, rooms, store, base, create, markClosed: () => (closed = true) };
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A client that connects and then goes silent: it never answers pings (like a frozen laptop). */
function silentClient(base: string, id: string) {
  const ws = new WebSocket(`ws://${base}/collab/${id}`, { autoPong: false });
  cleanup.push(() => ws.terminate());
  return ws;
}

describe('connection lifecycle', () => {
  it('drops a client that stops answering pings, and unloads its room', async () => {
    const s = await start({ heartbeatMs: 100 });
    const id = await s.create();
    const ws = silentClient(s.base, id);
    const closedByServer = new Promise<void>((r) => ws.on('close', () => r()));
    await until(() => s.rooms.liveRooms === 1);
    await closedByServer; // terminated after missing a ping
    await until(() => s.rooms.liveRooms === 0);
  });

  it('keeps clients that answer pings', async () => {
    const s = await start({ heartbeatMs: 100 });
    const id = await s.create();
    const ws = new WebSocket(`ws://${s.base}/collab/${id}`); // answers pings automatically
    cleanup.push(() => ws.terminate());
    await until(() => s.rooms.liveRooms === 1);
    await new Promise((r) => setTimeout(r, 500)); // five heartbeats
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(s.rooms.liveRooms).toBe(1);
  });

  it('shuts down promptly even when a client has gone silent', async () => {
    const s = await start(); // default 30 s heartbeat: the silent client is still "connected"
    const id = await s.create();
    silentClient(s.base, id);
    await until(() => s.rooms.liveRooms === 1);
    const t0 = Date.now();
    const closed = s.app.close().then(() => 'closed');
    const result = await Promise.race([closed, new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    s.markClosed();
    expect(result).toBe('closed');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('disconnects a client that stops reading instead of buffering for it without limit', async () => {
    const { slowClientsDropped } = await import('../src/metrics.js');
    const droppedBefore = (await slowClientsDropped.get()).values[0]?.value ?? 0;
    const s = await start({ maxBufferedBytes: 64 * 1024 });
    const id = await s.create();
    // The stalled client: connected, but its socket is paused so it never reads (a frozen tab, or
    // a phone on a dead network that hasn't timed out yet).
    const stalled = new WebSocket(`ws://${s.base}/collab/${id}`);
    cleanup.push(() => stalled.terminate());
    await new Promise<void>((r) => stalled.on('open', () => r()));
    (stalled as unknown as { _socket: { pause(): void } })._socket.pause();
    // An active user typing a lot: every update is broadcast to the stalled client too.
    const doc = new Y.Doc();
    const active = new WebsocketProvider(`ws://${s.base}/collab`, id, doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    cleanup.push(() => active.destroy());
    await new Promise<void>((r) => active.on('sync', (ok: boolean) => ok && r()));
    const chunk = 'x'.repeat(16 * 1024);
    let dropped = false;
    for (let i = 0; i < 400 && !dropped; i++) {
      doc.getText('code').insert(0, chunk);
      await new Promise((r) => setTimeout(r, 2));
      dropped = ((await slowClientsDropped.get()).values[0]?.value ?? 0) > droppedBefore;
    }
    expect(dropped).toBe(true); // the server cut off the client that wasn't reading
    expect(active.wsconnected).toBe(true); // and kept serving the one that was
  });

  it('refuses connections beyond the limit with 503, and admits again once someone leaves', async () => {
    const s = await start({ maxConnections: 2 });
    const id = await s.create();
    const open = () =>
      new Promise<{ ws: WebSocket; status: number }>((resolve) => {
        const ws = new WebSocket(`ws://${s.base}/collab/${id}`);
        ws.on('error', () => {}); // the refused one errors after its 503; that's expected
        cleanup.push(() => ws.readyState === WebSocket.OPEN && ws.terminate());
        ws.on('open', () => resolve({ ws, status: 101 }));
        ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
      });
    const a = await open();
    const b = await open();
    expect([a.status, b.status]).toEqual([101, 101]);
    const c = await open();
    expect(c.status).toBe(503);
    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect((await open()).status).toBe(101);
  });

  it('saves edits that were still only in memory when the server shuts down', async () => {
    const s = await start({ persistDebounceMs: 10_000 }); // the debounced save won't run on its own
    const id = await s.create();
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://${s.base}/collab`, id, doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    cleanup.push(() => provider.destroy());
    await new Promise<void>((r) => provider.on('sync', (ok: boolean) => ok && r()));
    doc.getText('code').insert(0, '// typed just before a deploy\n');
    await new Promise((r) => setTimeout(r, 100)); // reached the server, not saved yet
    await s.app.close();
    s.markClosed();
    const saved = new Y.Doc();
    Y.applyUpdate(saved, (await s.store.loadState(id))!);
    expect(saved.getText('code').toString().startsWith('// typed just before a deploy\n')).toBe(true);
  });
});
