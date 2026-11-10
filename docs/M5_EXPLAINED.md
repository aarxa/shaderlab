# M5 explained: load testing, and the four things it found

What was built, what was measured, what broke, and why each fix works. At the end: interview
questions with answers. Every number here comes from a JSON file in `server/load/results/`; you can
re-run any of them.

**Headline:** on one CPU core and 512 MB, the server went from falling over at **500** concurrent
editors (p99 3.3 s, event loop 2.4 s behind) to serving **1,000 at p99 168 ms**. When offered
**2,000**, it now admits about 1,000, refuses the rest with `503 Retry-After`, and keeps p99 at
142 ms. Before admission control, 2,000 editors crashed it (out of memory).

---

## The setup: how to measure a real-time server honestly

**What is measured.** End-to-end latency: the time from one editor making a change to another editor
*receiving* it, through the real server. Not "the server handled a message in 0.1 ms", because users
don't feel that. They feel the round trip.

**The load generator (`server/load/loadgen.ts`).**
- Each simulated editor is a real `y-websocket` client with a real `Y.Doc`, the same library the
  browser uses, so the server sees exactly the traffic a browser would send.
- Each editor types `--keys` characters per second (5 by default, fast human typing) at its own
  position and updates its cursor on every keystroke, as CodeMirror does.
- **The probe.** In each room, editor 0 writes the current time into a `Y.Map` every 200 ms. Every
  other editor in the room records `now - t` when it arrives. That's the latency sample. Sender and
  receiver are on the same machine, so their clocks are the same clock, with no skew.
- **Workers.** The editors are spread over `worker_threads`. One Node thread running 2,000 Yjs
  clients would itself fall behind, and its lag would show up as "server latency". The generator
  records its own event-loop lag and reports it next to the server's (`loadGeneratorLagP99MsWorst`)
  so you can show the bottleneck isn't the measuring tool. In the final runs it stayed under 2 ms.
- **The server is boxed in.** `docker-compose.load.yml` runs the production image with `cpus: 1.0`
  and `mem_limit: 512m`, against real Postgres. Without limits, the server would borrow every core
  on the laptop and the results would describe the laptop, not the server.

**Observability (`server/src/metrics.ts`, `GET /metrics`).** Prometheus counters and gauges:
connections, live rooms, messages in and out by type, bytes out, broadcasts, persist time, slow
clients dropped, connections refused, total bytes queued for sending, plus Node's built-in CPU,
memory, GC and **event-loop lag**. The load generator scrapes `/metrics` before and after each run to
report server CPU and message rates.

Event-loop lag is the key number for a Node server. One thread does everything. If messages arrive
faster than that thread can handle them, they queue, the lag grows, and every user's latency grows
with it. The lag is sampled at 1 ms resolution. Node's default of 10 ms made an idle server look
12 ms behind, which was a measurement error.

Run it:
```bash
docker compose -f docker-compose.yml -f docker-compose.load.yml up -d --build
cd server && npm run load -- --rooms 50 --editors 10 --duration 20 --label my-run
```

---

## Finding 1: every cursor move came back N−1 times (the cursor echo)

**Symptom.** At 500 editors (50 rooms × 10), the baseline server received **28,409 messages/s**.
The editors were typing 500 × 5 = 2,500 keystrokes/s. That's **11.4 inbound messages per keystroke**,
when there should be about 2 (the text change and the cursor move).

**Cause.** In `y-websocket`'s client, the provider listens to its awareness (presence) object and
sends an update to the server for *every* change, including changes it just *received from the server*
about other people. So when A moves its cursor:
1. A sends its cursor to the server, and the server broadcasts it to the other 9.
2. Each of those 9 applies it, which fires their awareness `update` event, so each sends A's cursor
   **back** to the server.
3. The server already has that exact state (same clock), so it decodes all 9 and discards them.

With N people in a room, each cursor move costs N−1 useless inbound messages, so inbound traffic
grows with N². Peer-to-peer setups need that re-gossip. With a central server it's pure waste.

**Fix (client, `web/src/awareness.ts`).** `sendOnlyLocalAwareness(provider)` swaps in a handler that
only sends when the change includes **our own** client id, and encodes only our entry. Remote
entries never include our id, so every echo disappears. Our own changes still go out, including the
"I left" removal on tab close. It's 25 lines and called right after creating the provider in
`Editor.tsx`.

**Fix (server, `collab.ts`).** The server also stopped broadcasting an awareness update back to the
socket that sent it. A test proves it ("does not send a user's own cursor update back to them").

**Measured.** At 250 editors, inbound fell from 13,904 to **2,629 msg/s** (2.1 per keystroke), CPU
from 70% to 43%, and p99 from 31 ms to 5.5 ms. A control run with only the server fix and the stock
client was no better than baseline (p99 6.3 s at 500). The client fix is the one that matters.

**Verified in the real editor:** two browser tabs on the production build, and B still shows A's
caret and name label.

---

## Finding 2: the server spent most of its time in system calls, not Yjs (write coalescing)

**Symptom.** After the echo fix, 500 editors still had p99 of 2 s. CPU, not the network, was the
limit.

**How it was found: a CPU profile, not a guess.** The container ran with `node --cpu-prof` during a
500-editor run. The profile:
- **51.8%** of all samples (about **80% of non-idle time**) were in the WebSocket send path, ending
  in `writev`, a system call.
- Yjs (decoding and applying updates) was **1.2%**.

The intuition "CRDTs are expensive" was wrong. The cost was **one system call per message per
recipient**. Each keystroke in a 10-person room fans out to 9 sockets, and each `send()` went
straight to the kernel.

**Fix: cork and uncork (`send()` in `collab.ts`).** The first time a socket is sent to during an
event-loop turn, the server calls `socket.cork()`, which tells Node to buffer writes in user space
instead of writing right away. It adds the socket to a `corked` set and schedules one `setImmediate`
for the whole set. When the current batch of incoming messages is done, `setImmediate` runs and
uncorks every socket. Each socket gets **one** `writev` with everything queued for it, instead of one
per message.
- Latency cost: zero in practice. `setImmediate` runs as soon as the current turn's I/O callbacks
  finish. Nothing waits on a timer.
- It's the same idea as Nagle's algorithm or batching database inserts: pay the fixed per-call cost
  once per batch, not once per item.

**Measured (500 editors).** p50 76 ms → **0.8 ms**, p99 2,048 ms → **19.9 ms**, CPU 85% → **50%**.
At 1,000 editors: p99 **168 ms** at 88% CPU.

---

## Finding 3: one silent connection could hang every deploy (heartbeat and shutdown)

**Symptom.** After a load run, `docker compose down` took 10 s and the container exited with code
**137**, which means it was SIGKILLed because it didn't stop in time.

**Cause, in two parts.**
1. A client that vanishes without closing its socket (laptop lid closed, network dropped, or
   here, a load-generator worker killed mid-run) leaves a **half-open** TCP connection. The server
   still thinks it's connected, so its room never unloads.
2. Fastify's `onClose` hook, where the server saved rooms and closed WebSockets, runs *after* the
   HTTP server closes. Closing the HTTP server waits for every upgraded socket to end. One ghost socket
   meant shutdown waited forever, so the platform SIGKILLed it.

**Real impact on the old code.** Any deploy while *anyone* was connected ended in SIGKILL, and edits
made in the last second (the save is debounced by 1 s) were lost.

**Fixes (`app.ts`).**
- **Heartbeat.** Every 30 s the server pings each socket. A socket that hasn't answered the previous
  ping (pong) is terminated. Browsers answer pings automatically. A ghost is dropped within 30–60 s
  and its room unloads.
- **Shutdown order.** A `preClose` hook (which runs *before* the HTTP server closes) stops the
  heartbeat and terminates every client. Then `onClose` saves every in-memory room, and the HTTP
  close finishes immediately.

**Tests (`server/test/lifecycle.test.ts`).** A client with `autoPong: false` is dropped and its room
unloaded. A normal client survives five heartbeats. Shutdown with a silent client finishes in well
under 3 s. An edit made 100 ms before shutdown, with the save timer set to 10 s, is in the store
after close.

---

## Finding 4: overload crashed the server, and the first theory was wrong (admission control)

**Symptom.** At 2,000 editors the server ran out of memory and died.

**First hypothesis: back-pressure.** If a client can't read as fast as the server sends, its
unsent data piles up in server memory without limit. That was plausible, so a cap was added: if a
socket's `bufferedAmount` exceeds 4 MB, terminate that client (metric `slow_clients_dropped_total`).
It's a real safeguard for a real failure (a frozen tab, or a phone on a dying network), and a test
proves it. A paused socket is dropped while an active client stays connected.

**But the data said no.** A new gauge, `shaderlab_send_buffer_bytes` (total queued across all sockets),
read only **3–4 MB** right before the crash, nowhere near 512 MB. The heap-watch script showed the
real story. CPU was pinned at 100%, the event loop fell seconds behind, incoming messages and their
garbage piled up faster than the garbage collector could run, and the heap grew until it died.
**The cause was CPU saturation, not slow clients.** The back-pressure cap stays as a safeguard, but
it was not the fix for this crash.

**Fix: admission control (`app.ts`, upgrade handler).** If `wss.clients.size >= maxConnections`, answer
the upgrade with `HTTP/1.1 503 Service Unavailable` and `Retry-After: 5`, and count it in
`connections_rejected_total`. The limit comes from `MAX_CONNECTIONS` (default 1,000, sized from
the 1-CPU measurements above: 1,000 editors used 88% CPU with p99 168 ms). `y-websocket` reconnects
with backoff, so a refused user retries rather than seeing a broken page.

The principle: **a server that's over capacity should refuse some users quickly, not serve every
user slowly until it dies.** Refusing costs almost nothing. Accepting a connection it can't serve
costs everyone.

**Measured (2,000 offered, cap 1,000).** 1,004 admitted (a few extra get in while earlier
connections are still counting), the rest refused. p50 **4.4 ms**, p99 **142 ms**, event-loop lag at
most 45 ms, heap at most 69 MB. The server stayed up. With the cap at 1,200, p99 was 354 ms, so 1,000
is the right number for one core.

**Test.** With `maxConnections: 2`, the third connection gets 503, and after one leaves, a new one
gets in.

---

## All the numbers (1 CPU, 512 MB, rooms of 10, 5 keystrokes/s each, 20 s runs)

| Editors | Version | p50 | p95 | p99 | Server CPU | Inbound msg/s |
|---:|---|---:|---:|---:|---:|---:|
| 250 | baseline | 1.5 ms | 14.3 ms | 30.9 ms | 70% | 13,904 |
| 500 | baseline | 695 ms | 2,641 ms | 3,294 ms | 102% | 28,409 |
| 1,000 | baseline | 225 ms | 2,687 ms | 3,746 ms | 116%* | 35,674 (178 connects failed) |
| 250 | + echo fix | 0.8 ms | 2.8 ms | 5.5 ms | 43% | 2,629 |
| 500 | + echo fix | 76 ms | 1,501 ms | 2,048 ms | 85% | 5,148 |
| 250 | final | 0.6 ms | 1.4 ms | 2.3 ms | 24% | 2,628 |
| 500 | final | 0.8 ms | 3.4 ms | 19.9 ms | 50% | 5,255 |
| 1,000 | final | 2.6 ms | 109 ms | 168 ms | 88% | 10,574 |
| 1,500 | final | 277 ms | 634 ms | 847 ms | 100% | 15,546 |
| 2,000 | final, no cap | | | | | crashed (out of memory) |
| 2,000 offered | final, cap 1,000 | 4.4 ms | 84 ms | 142 ms | | 1,004 admitted, server stayed up |

*Above 100% because Docker's CPU limit is a quota averaged over time, and the GC runs on extra
threads.

**What these numbers are, and what they aren't.** Localhost, so network latency is near zero. These
measure the server's own processing cost under load. The live site adds about 40 ms of network round
trip (measured in M1). Render's free tier gets a fraction of one CPU, not a whole one, so the live
server's capacity is roughly a tenth of these numbers, and `render.yaml` sets `MAX_CONNECTIONS=100`.

---

## Interview questions (cover the answer, say it out loud, then check)

**1. "Tell me about a performance problem you solved."**
> I load-tested my collaborative editor's sync server with simulated editors on one CPU core. It
> collapsed at 500 users: p99 over 3 seconds. Metrics showed 11 inbound messages per keystroke when
> there should be 2. The y-websocket client re-sends every presence update it receives, so traffic
> grew with N² per room. I patched the client to send only its own state. Then a CPU profile showed
> 80% of busy time in `writev` (one syscall per message per recipient), not in the CRDT. I added
> write coalescing with cork/uncork per event-loop turn. Final: 1,000 users at p99 168 ms, and the
> server degrades gracefully past that with admission control instead of crashing.

**2. How did you measure latency, and why can you trust it?**
> A probe: one client writes a timestamp into the shared doc every 200 ms, and the others measure
> arrival time. Same machine, so same clock. Load generation runs on worker threads, and I report the
> generator's own event-loop lag to show it isn't the bottleneck. The server runs in Docker with a
> 1-CPU, 512 MB limit, against real Postgres.

**3. Why is event-loop lag the key metric for Node?**
> One thread handles every message. If work arrives faster than it's done, it queues, and the lag is
> how long the queue is in time. It's added to every user's latency, so it predicts p99 directly.

**4. What does cork/uncork do, and why doesn't it add latency?**
> `cork()` buffers writes in user space, and `uncork()` flushes them in one `writev`. I uncork in
> `setImmediate`, which runs right after the current batch of I/O callbacks, with no timer. The
> messages would have waited for the thread anyway. Now they share one syscall.

**5. Your first theory for the OOM crash was back-pressure. How did you rule it out?**
> I added a gauge for total bytes queued across all sockets. It read 3–4 MB right before the crash,
> nowhere near the 512 MB limit. The heap growth came from CPU saturation: work and garbage piling up
> faster than they were processed. I kept the back-pressure cap because slow clients are a real
> failure mode, but the fix for overload was admission control.

**6. Why refuse connections instead of accepting everyone?**
> Past saturation, every new user makes every existing user slower, until the process dies and
> everyone is disconnected. A 503 with Retry-After costs almost nothing. The client backs off and
> retries, and the users already connected keep a good experience.

**7. What was the shutdown bug?**
> A half-open connection from a client that disappeared kept the HTTP server from closing, because it
> waits for upgraded sockets. Shutdown hung until the platform SIGKILLed it, losing up to a second of
> debounced edits. Fix: ping/pong heartbeat to drop dead sockets, and terminate clients in `preClose`
> so the save in `onClose` always runs. Tests cover both.

**8. What would you do to go past 1,000 users?**
> More processes. Rooms are independent, so route each room to one instance (consistent hashing on
> the shader id) or share updates between instances with Redis pub/sub (milestone M4). On a single
> process, the next step would be sending one pre-encoded buffer to many sockets, or moving the
> fan-out to a native WebSocket server like uWebSockets.

**9. Why is the echo N² and not N?**
> Each cursor move is broadcast to N−1 people, and each of them sends it back once: N−1 extra inbound
> messages per move. All N people are moving their cursors, so a room receives N(N−1) echoes per round
> of moves.
