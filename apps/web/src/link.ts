import { openSession, type Rooms } from '@mtg3d/rooms';
import type { GameUpdate, RoomState } from '@mtg3d/protocol';
import type { Hub } from './hub';

/** The messages between a guest and the host in serverless play (see p2p.ts). */
export type Wire =
  | { t: 'ask'; id: number; event: string; payload: unknown }
  | { t: 'ack'; id: number; ack: unknown }
  | { t: 'push'; event: 'room:state' | 'game:update'; data: unknown };

/** A message channel between guest and host: a WebRTC data channel, or an in-memory pair in tests. */
export interface Link {
  send(msg: Wire): void;
  onMessage(fn: (msg: unknown) => void): void;
  onClose(fn: () => void): void;
}

const isAsk = (m: unknown): m is Extract<Wire, { t: 'ask' }> =>
  typeof m === 'object' && m !== null && (m as Wire).t === 'ask' && typeof (m as { id: unknown }).id === 'number' && typeof (m as { event: unknown }).event === 'string';

/** Host side: one guest's link, served by a session on the host's rooms (payloads are validated there). */
export function serveLink(rooms: Rooms, link: Link): void {
  const session = openSession(rooms, {
    roomState: (data) => { link.send({ t: 'push', event: 'room:state', data }); },
    gameUpdate: (data) => { link.send({ t: 'push', event: 'game:update', data }); },
  });
  link.onMessage((m) => { if (isAsk(m)) link.send({ t: 'ack', id: m.id, ack: session.handle(m.event, m.payload) }); });
  link.onClose(() => { session.close(); });
}

/** Guest side: requests with answers, and the host's pushes forwarded to the hub. */
export function guestClient(link: Link, hub: Hub): (event: string, payload: unknown) => Promise<unknown> {
  let next = 1;
  const waiting = new Map<number, (ack: unknown) => void>();
  link.onMessage((raw) => {
    const m = raw as Wire;
    if (m.t === 'ack') { waiting.get(m.id)?.(m.ack); waiting.delete(m.id); }
    if (m.t === 'push' && m.event === 'room:state') hub.emit('room:state', m.data as RoomState);
    if (m.t === 'push' && m.event === 'game:update') hub.emit('game:update', m.data as GameUpdate);
  });
  return (event, payload) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    link.send({ t: 'ask', id, event, payload });
  });
}

