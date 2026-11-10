# ShaderLab

A collaborative GLSL shader playground. Open a link, write a fragment shader, see it render live,
and share the link: everyone on it edits the same code at the same time, Google-Docs style, with
each person's cursor and name visible.

**Live: https://shaderlab.onrender.com** (free tier: the first visit after ~15 idle minutes takes up to
a minute to wake the server).

Measured on the live deployment (Render, Oregon; client in San Jose): an edit typed by one user shows
up for another in **42 ms at p50, 114 ms at p95** over `wss://` (30 edits, one network round trip
through the server). Load testing with many concurrent editors is milestone M5.

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

## Architecture
```
 browser (React + CodeMirror 6 + WebGL2)          server (Node + Fastify + ws)            Postgres
 ┌───────────────────────────────┐   WebSocket   ┌──────────────────────────────┐      ┌──────────┐
 │ Y.Doc  ◄── y-codemirror ──► editor │ ◄──────────► │ RoomManager: one Room per shader │ ───► │ shaders  │
 │   │                           │  Yjs sync +   │  • live Y.Doc + Awareness    │ debounced  (id, ydoc_state,
 │   └─► ShaderRenderer (WebGL2) │  awareness    │  • relays updates, persists  │ snapshots  timestamps)
 └───────────────────────────────┘   protocol    │  • unloads idle rooms        │      └──────────┘
          HTTP: POST /api/shaders, GET /api/shaders (gallery), GET /api/shaders/:id,
                POST /api/shaders/:id/fork, GET /api/health
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
race conditions (messages arriving during a slow room load, and disconnecting mid-load). CI runs
typecheck, tests against a Postgres service container, and the production build.

## Roadmap
See [MILESTONES.md](MILESTONES.md).
