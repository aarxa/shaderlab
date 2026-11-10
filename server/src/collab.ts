// Real-time collaboration: one "room" per shader, holding the live Yjs document in memory.
//
// Wire protocol (compatible with the standard y-websocket client): every message starts with a
// varint type. 0 = sync (Yjs sync protocol: step 1 sends a state vector, step 2 replies with the
// missing updates, then incremental updates), 1 = awareness (cursor positions, user names).
//
// The CRDT does the conflict resolution: concurrent inserts/deletes from different users merge to
// the same result on every replica regardless of arrival order, so the server never has to lock
// or transform operations; it only relays updates and persists snapshots.
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { cleanTitle, type Store } from './store.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export const DEFAULT_SHADER = `// Edit me! mainImage runs once per pixel, Shadertoy-style.
// Uniforms: iResolution (vec3), iTime (float), iMouse (vec4)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
    fragColor = vec4(col, 1.0);
}
`;

/** Builds the initial Yjs state for a new shader. */
export function initialState(code = DEFAULT_SHADER): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('code').insert(0, code);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

export interface RoomOptions {
  persistDebounceMs: number;
}

class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** Each connection, and the awareness client ids it has announced (to clean up on disconnect). */
  readonly conns = new Map<WebSocket, Set<number>>();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(readonly id: string, private store: Store, private opts: RoomOptions) {
    this.awareness.setLocalState(null); // the server itself has no cursor
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin as WebSocket | null);
      this.schedulePersist();
    });
    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        const conn = origin as WebSocket | null;
        if (conn && this.conns.has(conn)) {
          // Track which awareness ids each connection controls so we can clear them on disconnect.
          // "added" only fires the first time an id is ever seen; a client that clears its state and
          // sets it again (y-websocket does this around reconnects) shows up as "updated", so both
          // count. Without this, those users stayed in everyone's presence list after leaving.
          const ids = this.conns.get(conn)!;
          added.forEach((id) => ids.add(id));
          updated.forEach((id) => ids.add(id));
          removed.forEach((id) => ids.delete(id));
        }
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(enc), null);
      },
    );
  }

  async load() {
    const state = await this.store.loadState(this.id);
    if (state) Y.applyUpdate(this.doc, state, 'load');
  }

  addConnection(conn: WebSocket) {
    this.conns.set(conn, new Set());
    // Start the sync handshake: send our state vector so the client replies with what we lack,
    // and the client's own step 1 makes us send what it lacks.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(conn, encoding.toUint8Array(enc));
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      send(conn, encoding.toUint8Array(a));
    }
  }

  handleMessage(conn: WebSocket, data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, conn); // origin = conn, so we don't echo it back
      if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), conn);
    } else {
      throw new Error(`unknown message type ${type}`);
    }
  }

  removeConnection(conn: WebSocket) {
    const ids = this.conns.get(conn);
    this.conns.delete(conn);
    if (ids && ids.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
  }

  private broadcast(message: Uint8Array, except: WebSocket | null) {
    for (const conn of this.conns.keys()) if (conn !== except) send(conn, message);
  }

  private schedulePersist() {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, this.opts.persistDebounceMs);
  }

  async persist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    // The title lives in the CRDT (so it syncs live like the code). We also copy it into a column on
    // every save so the gallery can list titles without loading every document. The CRDT is the
    // source of truth; the column is a denormalized copy, cleaned (trimmed, length-capped) here.
    const title = cleanTitle(this.doc.getMap('meta').get('title'));
    await this.store.saveState(this.id, Y.encodeStateAsUpdate(this.doc), title);
  }

  destroyed = false;

  destroy() {
    this.destroyed = true;
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function send(conn: WebSocket, message: Uint8Array) {
  if (conn.readyState !== conn.OPEN) return;
  conn.send(message, (err) => {
    if (err) conn.close();
  });
}

/** Owns all live rooms; loads them on first connection and unloads them when the last user leaves. */
export class RoomManager {
  private rooms = new Map<string, Promise<Room>>();

  constructor(private store: Store, private opts: RoomOptions = { persistDebounceMs: 1000 }) {}

  get liveRooms() {
    return this.rooms.size;
  }

  async join(id: string, conn: WebSocket) {
    // Attach listeners before any await: the client sends its sync step 1 as soon as the socket
    // opens, and with a database the room load can take a while. Messages that arrive meanwhile
    // are queued, and a client that leaves during the load is noticed.
    const queued: Uint8Array[] = [];
    let room: Room | null = null;
    let closed = false;
    conn.on('message', (data: Buffer) => {
      const msg = new Uint8Array(data);
      if (!room) return void queued.push(msg);
      this.handle(room, conn, msg);
    });
    conn.on('close', () => {
      closed = true;
      if (!room) return;
      room.removeConnection(conn);
      if (room.conns.size === 0) void this.unload(id, room);
    });

    let pending = this.rooms.get(id);
    if (!pending) {
      // Store the promise (not the room) so two users joining at once share one load.
      pending = (async () => {
        const r = new Room(id, this.store, this.opts);
        await r.load();
        return r;
      })();
      this.rooms.set(id, pending);
    }
    const loaded = await pending;
    if (closed) {
      if (loaded.conns.size === 0) void this.unload(id, loaded);
      return;
    }
    room = loaded;
    room.addConnection(conn);
    for (const msg of queued.splice(0)) this.handle(room, conn, msg);
  }

  private handle(room: Room, conn: WebSocket, msg: Uint8Array) {
    try {
      room.handleMessage(conn, msg);
    } catch {
      conn.close(1003, 'bad message');
    }
  }

  private async unload(id: string, room: Room) {
    await room.persist();
    // Someone may have joined while we were saving.
    if (room.conns.size === 0 && (await this.rooms.get(id)) === room) {
      this.rooms.delete(id);
      room.destroy();
    }
  }

  /**
   * The current in-memory state of a loaded room, including edits not saved yet (saves are
   * debounced), or null if nobody has the shader open. Forking uses this so it never drops the
   * newest edits.
   */
  async snapshot(id: string): Promise<{ state: Uint8Array; title: string } | null> {
    const pending = this.rooms.get(id);
    if (!pending) return null;
    const room = await pending;
    if (room.destroyed) return null; // unloaded meanwhile; it was saved first, so the store is current
    return { state: Y.encodeStateAsUpdate(room.doc), title: cleanTitle(room.doc.getMap('meta').get('title')) };
  }

  async flushAll() {
    for (const pending of this.rooms.values()) await (await pending).persist();
  }
}
