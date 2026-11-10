# ShaderLab

A collaborative GLSL shader playground. Open a link, write a fragment shader, see it render live,
and share the link: everyone on it edits the same code at the same time, Google-Docs style, with
each person's cursor and name visible.

**Live: https://shaderlab.onrender.com** (free tier: the first visit after ~15 idle minutes takes up to
a minute to wake the server).

Measured on the live deployment (Render, Oregon; client in San Jose): an edit typed by one user shows
up for another in **42 ms at p50, 114 ms at p95** over `wss://` (30 edits, one network round trip
through the server).

## Performance (load tested)
Simulated editors (real `y-websocket` clients, rooms of 10, each typing 5 keys/s and moving its cursor)
against the production image limited to **1 CPU and 512 MB**, with Postgres. Latency is edit on one
client → received by the others. Walkthrough of every finding: [docs/M5_EXPLAINED.md](docs/M5_EXPLAINED.md).

| Concurrent editors | Before | After |
|---:|---|---|
| 250 | p99 31 ms, CPU 70% | **p99 2.3 ms**, CPU 24% |
| 500 | p99 3,294 ms (event loop 2.4 s behind) | **p99 20 ms**, CPU 50% |
| 1,000 | p99 3,746 ms, 178 connections failed | **p99 168 ms**, CPU 88% |
| 2,000 offered | out-of-memory crash | 1,000 admitted at **p99 142 ms**, rest get `503 Retry-After` |

What changed, each found by measuring:
- **Cursor echo:** the stock y-websocket client re-sent every presence update it received, 11 inbound
  messages per keystroke (growing with N² per room). The client now sends only its own state: 2 per keystroke.
- **Write coalescing:** a CPU profile showed ~80% of busy time in `writev` and 1% in Yjs. Sockets are now
  corked per event-loop turn, so each gets one system call per batch instead of one per message.
- **Admission control:** past capacity the server refuses new connections quickly instead of slowing everyone
  down until it runs out of memory (`MAX_CONNECTIONS`).
- **Connection lifecycle:** ping/pong heartbeat drops half-open connections, which used to hang shutdown until
  SIGKILL (losing the last second of edits). Slow readers are cut off at 4 MB of queued data.

Prometheus metrics at `GET /metrics` (connections, rooms, messages, bytes, persist time, event-loop lag).
Reproduce: `docker compose -f docker-compose.yml -f docker-compose.load.yml up -d --build`, then
`cd server && npm run load -- --rooms 100 --editors 10`.

## Features
- **Live preview**: WebGL2, Shadertoy-style `mainImage(out vec4, in vec2)` with `iTime`, `iResolution`,
  `iMouse`. Recompiles 250 ms after you stop typing; on a compile error the last working version keeps
  running and the errors are shown inline on the right lines.
- **Real-time collaboration**: concurrent edits merge through a CRDT (Yjs), so there are no locks and
  no "someone else is editing" conflicts. Presence shows who is in the room and where their cursor is.
- **Persistence**: documents are stored in Postgres as compact CRDT snapshots and survive restarts.
- **Titles, forks, gallery**: titles sync live; Fork copies the current code (including unsaved live
  edits) into a new shader linked to its original; `/gallery` lists every shader newest first with
  cursor pagination. Schema changes go through numbered migrations. Walkthrough: docs/M2_EXPLAINED.md.
- **Thumbnails**: the editor of whoever is typing captures its live preview (320×180 WebP, JPEG on Safari)
  a few seconds after a successful compile and uploads it. The server checks the real format from the
  file's bytes, size and dimension limits, and a per-shader write rate, then serves versioned URLs that
  browsers cache forever. Walkthrough: docs/THUMBNAILS_EXPLAINED.md.

## Architecture
```
 browser (React + CodeMirror 6 + WebGL2)          server (Node + Fastify + ws)            Postgres
 ┌───────────────────────────────┐   WebSocket   ┌──────────────────────────────┐      ┌──────────┐
 │ Y.Doc  ◄── y-codemirror ──► editor │ ◄──────────► │ RoomManager: one Room per shader │ ───► │ shaders  │
 │   │                           │  Yjs sync +   │  • live Y.Doc + Awareness    │ debounced  (id, ydoc_state,
 │   └─► ShaderRenderer (WebGL2) │  awareness    │  • relays updates, persists  │ snapshots  timestamps)
 └───────────────────────────────┘   protocol    │  • unloads idle rooms        │      └──────────┘
          HTTP: POST /api/shaders, GET /api/shaders (gallery), GET /api/shaders/:id,
                POST /api/shaders/:id/fork,
                PUT|GET /api/shaders/:id/thumbnail, GET /api/health
```
- `server/src/collab.ts`: the sync server. Implements the Yjs sync + awareness wire protocol directly
  (it interoperates with the standard `y-websocket` client), tracks which presence ids each socket
  owns so users disappear when they disconnect, queues messages that arrive while a room is still
  loading from the database, and debounces saves (at most one write per room per second).
- `server/src/store.ts`: `Store` interface with `MemoryStore` (tests, quick local runs) and `PgStore`.
- `web/src/renderer.ts`: WebGL2 renderer, driver-log parsing into editor diagnostics.
- `web/src/Editor.tsx`: wires the Y.Doc to CodeMirror, presence, and the renderer.

## Run it
```bash
npm install
npm run dev                      # server on :8787 (in-memory storage), web on :5173
```
With Postgres:
```bash
docker compose up -d db          # Postgres on localhost:5433
DATABASE_URL=postgres://shaderlab:shaderlab@localhost:5433/shaderlab npm run dev -w server
```
Everything in containers: `docker compose up --build`, then open http://localhost:8787.

## Tests
```bash
npm test                                                     # collaboration tests, in-memory store
TEST_DATABASE_URL=postgres://shaderlab:shaderlab@localhost:5433/shaderlab npm test   # + Postgres
```
The collaboration tests drive real `y-websocket` clients against a real server: two-client sync,
concurrent edits converging, persistence after everyone leaves, presence cleanup on disconnect, and two
race conditions (messages arriving during a slow room load, and disconnecting mid-load). Lifecycle tests
cover the heartbeat, shutdown with a silent client, saving unsaved edits on shutdown, back-pressure, and
admission control. CI runs
typecheck, tests against a Postgres service container, and the production build.

## Roadmap
See [MILESTONES.md](MILESTONES.md).
