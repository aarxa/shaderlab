# Milestones

Milestone 1 (done) is the foundation: live editor + preview, real-time collaboration, Postgres
persistence, tests, Docker, CI. The next milestones are the features interviewers will ask you about,
so **build them yourself**: each one lists what to build, what "done" means, and the questions it
prepares you for. Ask Claude to review your PR or explain anything, but write the code.

## M2. Titles, forking, and a gallery (done; see docs/M2_EXPLAINED.md)
- Add `title` and `forked_from` columns (write a migration, don't edit the CREATE TABLE).
- Title is collaborative: store it in `doc.getMap('meta')` and show it in the header.
- `POST /api/shaders/:id/fork` copies the current document into a new shader.
- `GET /api/shaders?cursor=...` returns recent shaders for a gallery page, **cursor-paginated** (not
  OFFSET), each with a thumbnail (done: captured in the editor, validated and cached by the server; see
  docs/THUMBNAILS_EXPLAINED.md).
- Done when: tests for fork + pagination, gallery page live.
- Interview prep: why cursor pagination beats OFFSET; schema migrations; what a fork copies.

## M3. Accounts and permissions (auth + security)
- Sign in with GitHub OAuth (or email magic links). Sessions in an HTTP-only, SameSite cookie.
- Shaders get an owner; owners can make a shader read-only for others. Enforce it **on the server**:
  drop sync update messages from read-only connections (the client UI is not a security boundary).
- Replace the random cursor names with account names.
- Done when: a read-only viewer cannot change the document even with a hacked client (write that test).
- Interview prep: OAuth flow, CSRF, session vs. JWT, authorization in a real-time protocol.

## M4. Scaling past one server (distributed systems)
- Today every user of a shader must hit the same process. Add Redis pub/sub: each server publishes the
  Yjs updates it receives for a room and applies the ones other servers publish.
- Run two server instances behind a load balancer (docker compose + nginx) and prove two users on
  different instances still edit together.
- Add per-connection rate limiting (token bucket on messages/sec and bytes/sec) and a max document size.
- Done when: a test with two server instances converges; rate limiter has unit tests.
- Interview prep: sticky sessions vs. pub/sub fan-out, why CRDT updates are safe to apply twice
  (idempotence), back-pressure, what happens when Redis is down.

## M5. Load test and observability (done)
- Results in the README; every finding explained in docs/M5_EXPLAINED.md.
- Write a load generator (Node script or k6): N simulated editors per room typing at human speed.
- Measure end-to-end latency (edit on client A → visible on client B): p50/p95/p99 at 10, 100, 500
  concurrent editors. Find the bottleneck (CPU on broadcast? Postgres writes?) and fix one.
- Export Prometheus metrics: live rooms, connections, messages/sec, persist latency.
- Done when: a results table in the README ("500 concurrent editors across 50 rooms, p95 X ms").
- Interview prep: this is your best resume bullet; know every number and why it is what it is.

## M6. Deploy (done)
- Live on Render from `render.yaml` (Docker web service + managed Postgres), auto-deploys on push to main.
- Render's free Postgres expires 30 days after creation (around 2026-12-09): move `DATABASE_URL` to
  Neon's free tier or a paid Render database before then.
