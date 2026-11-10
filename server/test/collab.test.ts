// End-to-end tests with real y-websocket clients talking to a real server over WebSockets.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { buildApp } from '../src/app.js';
import { DEFAULT_SHADER } from '../src/collab.js';
import { MemoryStore } from '../src/store.js';


let app: Awaited<ReturnType<typeof buildApp>>['app'];
let rooms: Awaited<ReturnType<typeof buildApp>>['rooms'];
// MemoryStore with an adjustable load delay, to imitate a slow database.
class TestStore extends MemoryStore {
  loadDelayMs = 0;
  async loadState(id: string) {
    if (this.loadDelayMs) await new Promise((r) => setTimeout(r, this.loadDelayMs));
    return super.loadState(id);
  }
}
let store: TestStore;
let base: string;
const providers: WebsocketProvider[] = [];

beforeEach(async () => {
  store = new TestStore();
  ({ app, rooms } = await buildApp({ store, persistDebounceMs: 20 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  await app.close();
});

async function createShader(): Promise<string> {
  const res = await fetch(`http://${base}/api/shaders`, { method: 'POST' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function connect(id: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://${base}/collab`, id, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  providers.push(provider);
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    provider.on('sync', (s: boolean) => s && resolve());
  });
  return { doc, provider, text: doc.getText('code'), synced };
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('collaboration', () => {
  it('serves the starter shader to a new client', async () => {
    const id = await createShader();
    const a = connect(id);
    await a.synced;
    expect(a.text.toString()).toBe(DEFAULT_SHADER);
  });

  it('syncs edits between two clients', async () => {
    const id = await createShader();
    const a = connect(id);
    const b = connect(id);
    await Promise.all([a.synced, b.synced]);
    a.text.insert(0, '// from A\n');
    await until(() => b.text.toString().startsWith('// from A\n'));
  });

  it('merges concurrent edits to the same result on both sides', async () => {
    const id = await createShader();
    const a = connect(id);
    const b = connect(id);
    await Promise.all([a.synced, b.synced]);
    // Both edit before seeing each other's change: the CRDT must converge without a conflict.
    a.text.insert(0, 'AAA');
    b.text.insert(0, 'BBB');
    a.text.delete(a.text.length - 5, 5);
    await until(() => a.text.toString() === b.text.toString() && a.text.toString().includes('AAA') && a.text.toString().includes('BBB'));
  });

  it('persists the document after everyone leaves', async () => {
    const id = await createShader();
    const a = connect(id);
    await a.synced;
    a.text.insert(0, '// saved\n');
    await until(() => rooms.liveRooms === 1);
    a.provider.destroy();
    await until(() => rooms.liveRooms === 0); // room unloaded after persisting
    const c = connect(id);
    await c.synced;
    expect(c.text.toString().startsWith('// saved\n')).toBe(true);
  });

  it('removes a user from presence when they disconnect', async () => {
    const id = await createShader();
    const a = connect(id);
    const b = connect(id);
    await Promise.all([a.synced, b.synced]);
    a.provider.awareness.setLocalStateField('user', { name: 'A' });
    await until(() => b.provider.awareness.getStates().has(a.doc.clientID));
    a.provider.destroy();
    await until(() => !b.provider.awareness.getStates().has(a.doc.clientID));
  });

  it('syncs a client whose messages arrive while the room is still loading', async () => {
    const id = await createShader();
    store.loadDelayMs = 300;
    const a = connect(id);
    await a.synced; // would hang if the client's sync step 1 were dropped during the load
    expect(a.text.toString()).toBe(DEFAULT_SHADER);
  });

  it('cleans up a client that disconnects during the room load', async () => {
    const id = await createShader();
    store.loadDelayMs = 200;
    const a = connect(id);
    await until(() => a.provider.wsconnected);
    a.provider.destroy();
    await new Promise((r) => setTimeout(r, 400));
    expect(rooms.liveRooms).toBe(0);
  });

  it('rejects unknown shader ids', async () => {
    const ws = new WebSocket(`ws://${base}/collab/ZZZZZZZZZZ`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(status).toBe(404);
  });

  it('returns 404 for unknown shaders over HTTP', async () => {
    const res = await fetch(`http://${base}/api/shaders/ZZZZZZZZZZ`);
    expect(res.status).toBe(404);
  });
});
