import { CARDS } from '@mtg3d/cards';
import { io } from 'socket.io-client';
import type { ClientMessage, GameUpdate, RoomState } from '@mtg3d/protocol';
import { Hub } from './hub';

/** Built for GitHub Pages (no game server): rooms run in the host player's browser, see p2p.ts. */
export const P2P = import.meta.env.VITE_P2P === '1';

export const socket = new Hub();
let send: (event: string, payload: unknown) => Promise<unknown>;

if (P2P) {
  socket.connected = true; // nothing to connect to until a room is created or joined
  const p2p = import('./p2p').then((m) => m.createP2P(socket)); // PeerJS only in this build
  send = async (event, payload) => (await p2p)(event, payload);
} else {
  /** Same origin: Vite proxies /socket.io to the game server in development. */
  const io_ = io({ transports: ['websocket'] });
  io_.on('connect', () => { socket.setConnected(true); });
  io_.on('disconnect', () => { socket.setConnected(false); });
  io_.on('room:state', (s: RoomState) => { socket.emit('room:state', s); });
  io_.on('game:update', (u: GameUpdate) => { socket.emit('game:update', u); });
  send = (event, payload) => new Promise((resolve) => { io_.emit(event, payload, resolve); });
}

export function ask<T>(event: ClientMessage, payload: unknown): Promise<T> {
  return send(event, payload) as Promise<T>;
}

const SESSION_KEY = 'mtg3d.session';

export interface Session { code: string; token: string }

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch { return null; }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode: reconnection after reload just won't work */ }
}

/** Official card image by exact Oracle name, served by Scryfall (never cropped or recolored); a back face asks for face=back. */
export function cardImage(name: string): string {
  const front = CARDS.get(name)?.frontFace;
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(front ?? name)}&format=image&version=normal${front ? '&face=back' : ''}`;
}
