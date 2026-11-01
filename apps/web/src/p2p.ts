import Peer, { type DataConnection } from 'peerjs';
import { openSession, Rooms, type RoomRecord, type RoomStore } from '@mtg3d/rooms';
import type { Hub } from './hub';
import { guestClient, serveLink, type Link } from './link';

/**
 * Serverless play (GitHub Pages): the player who creates the room runs it in their browser, with the same room code
 * the server uses, and the friend connects straight to them over WebRTC. PeerJS's public broker only introduces the
 * two browsers; game messages go peer to peer.
 * shortcut: the host's browser holds the whole game state (both hands, the library order), so this mode trusts the
 * host not to peek in the developer tools; use the server (docs/deploy.md) for games that must be cheat-proof.
 */

const linkOf = (conn: DataConnection): Link => ({
  send: (msg) => { void conn.send(msg); },
  onMessage: (fn) => { conn.on('data', fn); },
  onClose: (fn) => { conn.on('close', fn); conn.on('error', fn); },
});

const ROLE_KEY = 'mtg3d.p2pRole';
const ROOMS_KEY = 'mtg3d.hostRooms';
const peerId = (code: string) => `mtg3d-vyxode-${code.toUpperCase()}`;
// Tokens are compared as they are: they never leave the host's own browser storage.
const plain = (token: string) => token;

/** The host's rooms survive a reload of the host's page: they are replayed from localStorage like the server replays Postgres. */
const browserStore: RoomStore = {
  save: (r) => { write({ ...read(), [r.code]: r }); return Promise.resolve(); },
  delete: (code) => { const all = read(); Reflect.deleteProperty(all, code); write(all); return Promise.resolve(); },
  loadAll: () => Promise.resolve(Object.values(read())),
};
function read(): Record<string, RoomRecord> {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY) ?? '{}') as Record<string, RoomRecord>; } catch { return {}; }
}
function write(all: Record<string, RoomRecord>): void {
  try { localStorage.setItem(ROOMS_KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the room just won't survive a reload */ }
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer();
    peer.once('open', () => { resolve(peer); });
    peer.once('error', (e) => { reject(e); });
  });
}

/** The ask() of serverless mode: the same messages as the server, answered by the local host or sent to the host. */
export function createP2P(hub: Hub): (event: string, payload: unknown) => Promise<unknown> {
  let host: { rooms: Rooms; local: ReturnType<typeof openSession> } | null = null;
  let guest: ((event: string, payload: unknown) => Promise<unknown>) | null = null;

  async function becomeHost(restore: boolean): Promise<NonNullable<typeof host>> {
    const rooms = restore ? await Rooms.load(plain, browserStore) : new Rooms(plain, browserStore);
    const local = openSession(rooms, {
      roomState: (s) => { hub.emit('room:state', s); },
      gameUpdate: (u) => { hub.emit('game:update', u); },
    });
    setInterval(() => { rooms.sweep(); }, 60_000);
    host = { rooms, local };
    return host;
  }

  async function listen(rooms: Rooms, code: string): Promise<void> {
    const peer = await openPeer(peerId(code));
    peer.on('connection', (conn) => { conn.on('open', () => { serveLink(rooms, linkOf(conn)); }); });
  }

  /** Connects to the host and keeps reconnecting if the link drops; the UI rejoins with its token on 'connect'. */
  async function becomeGuest(code: string): Promise<void> {
    const peer = await openPeer();
    await new Promise<void>((resolve, reject) => {
      const connect = (first: boolean) => {
        const conn = peer.connect(peerId(code), { reliable: true });
        const failed = (e: unknown) => {
          if (first) reject(e instanceof Error ? e : new Error('no se pudo conectar con el anfitrión'));
          else setTimeout(() => { connect(false); }, 3000);
        };
        peer.once('error', failed);
        conn.on('open', () => {
          peer.off('error', failed);
          const link = linkOf(conn);
          guest = guestClient(link, hub);
          link.onClose(() => {
            hub.setConnected(false);
            setTimeout(() => { connect(false); }, 3000);
          });
          if (first) resolve(); else hub.setConnected(true);
        });
      };
      connect(true);
    });
  }

  return async (event, payload) => {
    try {
      if (event === 'room:create') {
        const h = host ?? await becomeHost(false);
        const ack = h.local.handle(event, payload);
        if (ack.ok && 'code' in ack) { await listen(h.rooms, ack.code); localStorage.setItem(ROLE_KEY, 'host'); }
        return ack;
      }
      if (event === 'room:join' && !guest) {
        await becomeGuest((payload as { code: string }).code);
        localStorage.setItem(ROLE_KEY, 'guest');
      }
      if (event === 'room:rejoin' && !host && !guest) {
        const code = (payload as { code: string }).code;
        if (localStorage.getItem(ROLE_KEY) === 'host') await listen((await becomeHost(true)).rooms, code);
        else await becomeGuest(code);
      }
      if (host) return host.local.handle(event, payload);
      if (guest) return await guest(event, payload);
      return { ok: false, error: 'No estás en una sala.' };
    } catch (e) {
      return { ok: false, error: `No se pudo conectar con el otro navegador (${e instanceof Error ? e.message : String(e)}).` };
    }
  };
}
