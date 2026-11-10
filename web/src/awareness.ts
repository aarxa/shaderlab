// y-websocket's provider sends an awareness message for *every* awareness change, including the
// ones it just received from the server about other people. With a central server those echoes are
// pure waste: the server already has that state (same clock), so it does nothing with them except
// decode and discard. In a room of N users every cursor move came back N-1 times, so inbound
// traffic grew with N squared. The load test found this (docs/M5_EXPLAINED.md).
//
// Fix: replace the provider's handler with one that only sends *our own* entry. Remote users'
// entries never include our client id, so this drops every echo while still sending our own
// changes, including the removal y-websocket sends for us when the tab closes.
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import type { WebsocketProvider } from 'y-websocket';

const MESSAGE_AWARENESS = 1;

type Changes = { added: number[]; updated: number[]; removed: number[] };

export function sendOnlyLocalAwareness(provider: WebsocketProvider) {
  const p = provider as unknown as {
    _awarenessUpdateHandler: (changes: Changes, origin: unknown) => void;
    wsconnected: boolean;
    ws: WebSocket | null;
  };
  const awareness = provider.awareness;
  awareness.off('update', p._awarenessUpdateHandler);
  const handler = ({ added, updated, removed }: Changes) => {
    const me = awareness.clientID;
    if (!added.includes(me) && !updated.includes(me) && !removed.includes(me)) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [me]));
    if (p.wsconnected && p.ws) p.ws.send(encoding.toUint8Array(enc));
  };
  p._awarenessUpdateHandler = handler; // so provider.destroy() unregisters ours
  awareness.on('update', handler);
}
