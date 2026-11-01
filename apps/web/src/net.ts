import { CARDS } from '@mtg3d/cards';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '@mtg3d/protocol';

export type GameSocket = Socket<ServerToClient, ClientToServer>;

/** Same origin: Vite proxies /socket.io to the game server in development. */
export const socket: GameSocket = io({ transports: ['websocket'] });

export function ask<T>(event: keyof ClientToServer, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    (socket.emit as (e: string, p: unknown, ack: (r: T) => void) => void)(event, payload, resolve);
  });
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
