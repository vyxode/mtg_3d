import { randomBytes, randomInt } from 'node:crypto';
import { createGame, eventsFor, step, viewFor, type GameEvent, type GameState, type PlayerId, type Response } from '@mtg3d/engine';
import { CARDS, validateCasualDeck } from '@mtg3d/cards';
import type { GameUpdate, RoomState } from '@mtg3d/protocol';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const PLAYERS: PlayerId[] = ['p1', 'p2'];

/** Where a seat's messages go: a live socket, or nowhere while disconnected. */
export interface Outbox {
  roomState(s: RoomState): void;
  gameUpdate(u: GameUpdate): void;
}

interface Seat {
  name: string;
  token: string;
  out: Outbox | null;
  deck: string[] | null;
  fullControl: boolean;
}

export class Room {
  readonly seats: Partial<Record<PlayerId, Seat>> = {};
  state: GameState | null = null;
  version = 0;

  constructor(readonly code: string) {}

  status(): RoomState['status'] {
    if (this.state?.result) return 'finished';
    if (this.state) return 'playing';
    return this.seats.p1 && this.seats.p2 ? 'choosingDecks' : 'waiting';
  }

  seatByToken(token: string): PlayerId | null {
    return PLAYERS.find((p) => this.seats[p]?.token === token) ?? null;
  }

  addPlayer(name: string, out: Outbox): { seat: PlayerId; token: string } | null {
    const seat = PLAYERS.find((p) => !this.seats[p]);
    if (!seat) return null;
    const token = randomBytes(24).toString('base64url');
    this.seats[seat] = { name, token, out, deck: null, fullControl: false };
    this.broadcastRoom();
    return { seat, token };
  }

  attach(seat: PlayerId, out: Outbox | null): void {
    const s = this.seats[seat];
    if (!s) return;
    s.out = out;
    this.broadcastRoom();
    if (out && this.state) out.gameUpdate(this.updateFor(seat, []));
  }

  setDeck(seat: PlayerId, deck: string[]): string | null {
    if (this.state) return 'La partida ya ha empezado.';
    const errors = validateCasualDeck(deck, CARDS);
    if (errors.length) return errors.join(' ');
    (this.seats[seat] as Seat).deck = deck;
    const d1 = this.seats.p1?.deck;
    const d2 = this.seats.p2?.deck;
    if (d1 && d2) {
      const created = createGame({ seed: randomInt(2 ** 31), decks: { p1: d1, p2: d2 } }, CARDS); // seed from a CSPRNG, never sent
      if (!created.ok) return created.error;
      this.state = created.state;
      this.version = 1;
      this.broadcastRoom();
      this.broadcastGame(created.events);
    } else {
      this.broadcastRoom();
    }
    return null;
  }

  setFullControl(seat: PlayerId, on: boolean): void {
    (this.seats[seat] as Seat).fullControl = on;
    this.broadcastRoom();
  }

  input(seat: PlayerId, input: { decisionId: number; response: Response } | { concede: true }): string | null {
    if (!this.state) return 'La partida no ha empezado.';
    const r = step(this.state, 'concede' in input ? { player: seat, concede: true } : { player: seat, ...input }, CARDS);
    if (!r.ok) return r.error;
    this.state = r.state;
    const events = [...r.events, ...this.autoPass()];
    this.version += 1;
    if (this.state.result) this.broadcastRoom();
    this.broadcastGame(events);
    return null;
  }

  /**
   * Passes priority for a player who has nothing to decide, so a turn does not take dozens of clicks.
   * Runs on the server so the time a player takes never reveals what they hold.
   */
  private autoPass(): GameEvent[] {
    const events: GameEvent[] = [];
    for (let i = 0; i < 500; i++) {
      const s = this.state as GameState;
      const p = s.pending;
      if (p?.kind !== 'priority' || !this.shouldAutoPass(s, p.player, p.legal)) break;
      const r = step(s, { player: p.player, decisionId: p.id, response: { kind: 'pass' } }, CARDS);
      if (!r.ok) break;
      this.state = r.state;
      events.push(...r.events);
    }
    return events;
  }

  private shouldAutoPass(s: GameState, p: PlayerId, legal: { kind: string }[]): boolean {
    if (this.seats[p]?.fullControl) return false;
    const top = s.stack[s.stack.length - 1];
    if (top) return top.controller === p; // respond to the opponent's spells; let your own resolve
    // Floating mana alone is not a reason to stop: stop only when a land or spell can be played.
    if (!legal.some((a) => a.kind !== 'activateMana')) return true;
    const own = s.turn.active === p;
    const stops = own ? ['main1', 'main2', 'declareBlockers'] : ['declareAttackers', 'end'];
    return !stops.includes(s.turn.step);
  }

  roomStateFor(seat: PlayerId): RoomState {
    const info = (p: PlayerId) => {
      const s = this.seats[p];
      return s ? { name: s.name, connected: s.out !== null, ready: s.deck !== null } : null;
    };
    return { code: this.code, you: seat, status: this.status(), seats: { p1: info('p1'), p2: info('p2') }, fullControl: this.seats[seat]?.fullControl ?? false };
  }

  private updateFor(seat: PlayerId, events: GameEvent[]): GameUpdate {
    const s = this.state as GameState;
    return { version: this.version, view: viewFor(s, CARDS, seat), events: eventsFor(events, seat) };
  }

  private broadcastRoom(): void {
    for (const p of PLAYERS) this.seats[p]?.out?.roomState(this.roomStateFor(p));
  }

  private broadcastGame(events: GameEvent[]): void {
    for (const p of PLAYERS) this.seats[p]?.out?.gameUpdate(this.updateFor(p, events));
  }
}

// shortcut: rooms live in memory and are never deleted; persist the input log (Postgres) and expire idle rooms in phase G.
export class Rooms {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    let code: string;
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }
}
