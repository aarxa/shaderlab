// Load generator: many simulated editors typing into shared shaders, measuring how long an edit
// takes to reach everyone else in the room.
//
//   npm run load -- --base http://localhost:8787 --rooms 20 --editors 10 --duration 30
//   (compiles to load/dist first: worker threads need plain JavaScript)
//
// Each simulated editor is a real y-websocket client (its own WebSocket and Y.Doc) that types
// --keys characters per second at its cursor and, like the real editor, broadcasts its cursor
// position on every keystroke. In every room, editor 0 also writes a timestamped probe every 200 ms;
// every other editor records how long that probe took to arrive. Those arrival times are the
// latency numbers: "I typed, you saw it", including the server's fan-out under load.
//
// Work is split across worker threads so the load generator itself isn't the bottleneck; each worker
// reports its own event-loop lag so you can tell if it was.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';

interface Config {
  base: string; // http(s)://host:port
  rooms: number;
  editors: number; // per room
  keys: number; // keystrokes per second per editor
  duration: number; // seconds of measurement
  warmup: number; // seconds before measuring
  workers: number;
  label: string;
  client: 'patched' | 'stock';
}

interface WorkerInput {
  base: string;
  roomIds: string[];
  editors: number;
  keys: number;
  duration: number;
  warmup: number;
  client: 'patched' | 'stock';
}

interface WorkerResult {
  latencies: number[];
  keystrokes: number;
  probesSent: number;
  connectFailures: number;
  disconnects: number;
  clientLagP99Ms: number;
}

const now = () => performance.timeOrigin + performance.now(); // comparable across worker threads
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs(): Config {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : d;
  };
  const rooms = Number(get('rooms', '10'));
  return {
    base: get('base', 'http://localhost:8787').replace(/\/$/, ''),
    rooms,
    editors: Number(get('editors', '10')),
    keys: Number(get('keys', '5')),
    duration: Number(get('duration', '30')),
    warmup: Number(get('warmup', '5')),
    workers: Number(get('workers', String(Math.min(rooms, Math.max(1, availableParallelism() - 2))))),
    label: get('label', ''),
    // "patched" = the web app's client (sends only its own cursor changes, web/src/awareness.ts);
    // "stock" = y-websocket as shipped (echoes everyone's cursor changes back to the server).
    client: get('client', 'patched') === 'stock' ? 'stock' : 'patched',
  };
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Same fix as web/src/awareness.ts (kept in sync by hand: this package can't import the web one).
function sendOnlyLocalAwareness(provider: WebsocketProvider) {
  type Changes = { added: number[]; updated: number[]; removed: number[] };
  const p = provider as unknown as { _awarenessUpdateHandler: (c: Changes) => void; wsconnected: boolean; ws: WebSocket | null };
  const awareness = provider.awareness;
  awareness.off('update', p._awarenessUpdateHandler);
  const handler = ({ added, updated, removed }: Changes) => {
    const me = awareness.clientID;
    if (!added.includes(me) && !updated.includes(me) && !removed.includes(me)) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [me]));
    if (p.wsconnected && p.ws) p.ws.send(encoding.toUint8Array(enc));
  };
  p._awarenessUpdateHandler = handler;
  awareness.on('update', handler);
}

// ---------- worker: runs the simulated editors for a subset of rooms ----------
async function runWorker(input: WorkerInput): Promise<WorkerResult> {
  const wsBase = input.base.replace(/^http/, 'ws') + '/collab';
  process.setMaxListeners(0); // each y-websocket provider adds a process 'exit' listener
  // 1 ms sampling: the reported delay includes the sampling interval, so a coarse one hides real lag.
  const lag = monitorEventLoopDelay({ resolution: 1 });
  const result: WorkerResult = { latencies: [], keystrokes: 0, probesSent: 0, connectFailures: 0, disconnects: 0, clientLagP99Ms: 0 };
  const providers: WebsocketProvider[] = [];
  const timers: NodeJS.Timeout[] = [];
  let measuring = false;

  const rooms = input.roomIds.map((roomId) =>
    Array.from({ length: input.editors }, (_, e) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(wsBase, roomId, doc, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        disableBc: true, // every update must go through the server
      });
      if (input.client === 'patched') sendOnlyLocalAwareness(provider);
      provider.awareness.setLocalStateField('user', { name: `load-${roomId}-${e}`, color: '#888888' });
      provider.on('connection-close', () => measuring && result.disconnects++);
      providers.push(provider);
      return { doc, provider, e };
    }),
  );

  // Wait for every client to finish its initial sync.
  const syncDeadline = Date.now() + 20_000;
  for (const c of rooms.flat()) {
    while (!c.provider.synced && Date.now() < syncDeadline) await sleep(20);
    if (!c.provider.synced) result.connectFailures++;
  }

  for (const editors of rooms) {
    for (const c of editors) {
      const text = c.doc.getText('code');
      const probe = c.doc.getMap('probe');
      // Receivers: measure probe arrival.
      if (c.e !== 0) {
        probe.observe((ev) => {
          if (!measuring || ev.transaction.local) return;
          const p = probe.get('p') as { t: number } | undefined;
          if (p) result.latencies.push(now() - p.t);
        });
      }
      // Typing: one character per tick at this editor's own cursor, plus a cursor (awareness) update.
      let cursor = Math.floor(Math.random() * Math.max(1, text.length));
      const tick = 1000 / input.keys;
      const start = setTimeout(() => {
        timers.push(
          setInterval(() => {
            cursor = Math.min(cursor, text.length);
            text.insert(cursor, String.fromCharCode(97 + Math.floor(Math.random() * 26)));
            cursor++;
            c.provider.awareness.setLocalStateField('cursor', { anchor: cursor, head: cursor });
            if (measuring) result.keystrokes++;
          }, tick),
        );
      }, Math.random() * tick); // stagger so editors don't all type in the same millisecond
      timers.push(start);
    }
    // Probe writer: editor 0.
    const writer = editors[0];
    let seq = 0;
    timers.push(
      setInterval(() => {
        writer.doc.getMap('probe').set('p', { t: now(), s: seq++ });
        if (measuring) result.probesSent++;
      }, 200),
    );
  }

  await sleep(input.warmup * 1000);
  lag.enable();
  measuring = true;
  await sleep(input.duration * 1000);
  measuring = false;
  lag.disable();
  result.clientLagP99Ms = lag.percentile(99) / 1e6;
  for (const t of timers) clearInterval(t);
  for (const p of providers) p.destroy();
  return result;
}

// ---------- main: creates rooms, starts workers, scrapes server metrics, reports ----------
async function scrape(base: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const text = await (await fetch(`${base}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const i = line.lastIndexOf(' ');
      out.set(line.slice(0, i), Number(line.slice(i + 1)));
    }
  } catch {
    // metrics unavailable (e.g. protected); report without them
  }
  return out;
}

async function main() {
  const cfg = parseArgs();
  const total = cfg.rooms * cfg.editors;
  console.log(`${cfg.label ? cfg.label + ': ' : ''}${cfg.rooms} rooms x ${cfg.editors} editors = ${total} editors, ` +
    `${cfg.keys} keys/s each, ${cfg.duration}s (+${cfg.warmup}s warmup), ${cfg.client} client, ${cfg.workers} workers -> ${cfg.base}`);

  const roomIds: string[] = [];
  for (let i = 0; i < cfg.rooms; i++) {
    const res = await fetch(`${cfg.base}/api/shaders`, { method: 'POST' });
    if (res.status !== 201) throw new Error(`could not create room: HTTP ${res.status}`);
    roomIds.push(((await res.json()) as { id: string }).id);
  }

  // Scrape server metrics during the measurement window.
  let lagMaxP99 = 0;
  let before = new Map<string, number>();
  let after = new Map<string, number>();
  const scrapeLoop = (async () => {
    await sleep(cfg.warmup * 1000);
    before = await scrape(cfg.base);
    const end = Date.now() + cfg.duration * 1000;
    while (Date.now() < end) {
      await sleep(2000);
      const m = await scrape(cfg.base);
      lagMaxP99 = Math.max(lagMaxP99, m.get('nodejs_eventloop_lag_p99_seconds') ?? 0);
      after = m;
    }
  })();

  const perWorker: string[][] = Array.from({ length: cfg.workers }, () => []);
  roomIds.forEach((id, i) => perWorker[i % cfg.workers].push(id));
  const results = await Promise.all(
    perWorker.filter((ids) => ids.length > 0).map(
      (ids) =>
        new Promise<WorkerResult>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {
            workerData: { base: cfg.base, roomIds: ids, editors: cfg.editors, keys: cfg.keys, duration: cfg.duration, warmup: cfg.warmup, client: cfg.client } satisfies WorkerInput,
          });
          w.once('message', resolve);
          w.once('error', reject);
        }),
    ),
  );
  await scrapeLoop;

  const lat = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const sum = (f: (r: WorkerResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const delta = (k: string) => (after.get(k) ?? NaN) - (before.get(k) ?? NaN);
  const secs = cfg.duration;
  const report = {
    label: cfg.label,
    config: cfg,
    editors: total,
    latencyMs: {
      samples: lat.length,
      p50: quantile(lat, 0.5),
      p95: quantile(lat, 0.95),
      p99: quantile(lat, 0.99),
      max: lat[lat.length - 1],
    },
    keystrokesPerSec: sum((r) => r.keystrokes) / secs,
    expectedKeystrokesPerSec: total * cfg.keys,
    probesSent: sum((r) => r.probesSent),
    expectedProbeDeliveries: sum((r) => r.probesSent) * (cfg.editors - 1),
    connectFailures: sum((r) => r.connectFailures),
    disconnects: sum((r) => r.disconnects),
    server: {
      cpuPercent: (delta('process_cpu_seconds_total') / secs) * 100,
      messagesInPerSec: (delta('shaderlab_messages_received_total{type="sync"}') + delta('shaderlab_messages_received_total{type="awareness"}')) / secs,
      messagesOutPerSec: delta('shaderlab_messages_sent_total') / secs,
      mbOutPerSec: delta('shaderlab_bytes_sent_total') / secs / 1e6,
      eventLoopLagP99MsWorst: lagMaxP99 * 1000,
      rssMb: (after.get('process_resident_memory_bytes') ?? NaN) / 1e6,
    },
    loadGeneratorLagP99MsWorst: Math.max(...results.map((r) => r.clientLagP99Ms)),
  };

  const f = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
  console.log(
    `  latency p50 ${f(report.latencyMs.p50, 1)} ms | p95 ${f(report.latencyMs.p95, 1)} ms | p99 ${f(report.latencyMs.p99, 1)} ms | max ${f(report.latencyMs.max)} ms` +
      ` (${report.latencyMs.samples} samples, ${f((100 * report.latencyMs.samples) / Math.max(1, report.expectedProbeDeliveries), 1)}% of expected)`,
  );
  console.log(
    `  server: CPU ${f(report.server.cpuPercent)}% | in ${f(report.server.messagesInPerSec)} msg/s | out ${f(report.server.messagesOutPerSec)} msg/s` +
      ` (${f(report.server.mbOutPerSec, 1)} MB/s) | event-loop lag p99 ${f(report.server.eventLoopLagP99MsWorst, 1)} ms | RSS ${f(report.server.rssMb)} MB`,
  );
  console.log(
    `  typed ${f(report.keystrokesPerSec)}/${f(report.expectedKeystrokesPerSec)} keys/s | connect failures ${report.connectFailures} | disconnects ${report.disconnects}` +
      ` | load-generator lag p99 ${f(report.loadGeneratorLagP99MsWorst, 1)} ms`,
  );

  mkdirSync('load/results', { recursive: true });
  const file = `load/results/${new Date().toISOString().replace(/[:.]/g, '-')}${cfg.label ? '-' + cfg.label : ''}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`  saved ${file}`);
  process.exit(0); // y-websocket leaves reconnect timers behind; don't wait for them
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runWorker(workerData as WorkerInput).then((r) => {
    parentPort!.postMessage(r);
    process.exit(0); // ends this worker thread only
  });
}
