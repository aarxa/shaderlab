// Prometheus metrics. Scraped from GET /metrics; the load test reads them before and after a run.
import client from 'prom-client';

export const registry = new client.Registry();
// Process CPU, memory, GC, and event-loop lag. Event-loop lag is the key one for a Node server: one
// thread runs everything, so if handling messages takes longer than they arrive, the lag grows and
// every user's latency grows with it.
// 1 ms sampling: the reported lag includes the sampling interval, so 10 ms (the default) would hide
// everything below ~10 ms.
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 1 });

export const connections = new client.Gauge({
  name: 'shaderlab_connections',
  help: 'Open collaboration WebSocket connections',
  registers: [registry],
});
export const liveRooms = new client.Gauge({
  name: 'shaderlab_live_rooms',
  help: 'Shaders currently loaded in memory',
  registers: [registry],
});
export const messagesIn = new client.Counter({
  name: 'shaderlab_messages_received_total',
  help: 'Collaboration messages received from clients',
  labelNames: ['type'] as const,
  registers: [registry],
});
export const messagesOut = new client.Counter({
  name: 'shaderlab_messages_sent_total',
  help: 'Collaboration messages sent to clients (one per recipient)',
  registers: [registry],
});
export const bytesOut = new client.Counter({
  name: 'shaderlab_bytes_sent_total',
  help: 'Bytes sent to clients',
  registers: [registry],
});
export const broadcasts = new client.Counter({
  name: 'shaderlab_broadcasts_total',
  help: 'Messages fanned out to a room (each sent to every other member)',
  labelNames: ['type'] as const,
  registers: [registry],
});
export const persistSeconds = new client.Histogram({
  name: 'shaderlab_persist_duration_seconds',
  help: 'Time to encode and save a room to storage',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});
export const slowClientsDropped = new client.Counter({
  name: 'shaderlab_slow_clients_dropped_total',
  help: 'Clients disconnected because too much unsent data was queued for them (back-pressure)',
  registers: [registry],
});
export const connectionsRejected = new client.Counter({
  name: 'shaderlab_connections_rejected_total',
  help: 'WebSocket connections refused because the server was at its connection limit (admission control)',
  registers: [registry],
});
