import type { GameUpdate, RoomState } from '@mtg3d/protocol';

export interface HubEvents {
  connect: () => void;
  disconnect: () => void;
  'room:state': (s: RoomState) => void;
  'game:update': (u: GameUpdate) => void;
}

/** What the UI listens to, whichever transport is underneath (Socket.IO server or peer-to-peer). */
export class Hub {
  connected = false;
  private readonly listeners = new Map<keyof HubEvents, Set<(data?: unknown) => void>>();

  on<E extends keyof HubEvents>(event: E, fn: HubEvents[E]): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn as (data?: unknown) => void);
    this.listeners.set(event, set);
  }

  off<E extends keyof HubEvents>(event: E, fn: HubEvents[E]): void {
    this.listeners.get(event)?.delete(fn as (data?: unknown) => void);
  }

  emit<E extends keyof HubEvents>(event: E, ...data: Parameters<HubEvents[E]>): void {
    for (const fn of this.listeners.get(event) ?? []) fn(data[0]);
  }

  setConnected(on: boolean): void {
    if (this.connected === on) return;
    this.connected = on;
    this.emit(on ? 'connect' : 'disconnect');
  }
}
