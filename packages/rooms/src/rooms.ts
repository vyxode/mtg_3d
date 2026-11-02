import { createGame, eventsFor, step, viewFor, type GameEvent, type GameState, type PlayerId, type PlayerInput, type Response } from '@mtg3d/engine';
import { CARDS, validateCasualDeck } from '@mtg3d/cards';
import type { GameUpdate, RoomState } from '@mtg3d/protocol';
import type { RoomRecord, RoomStore, SeatRecord } from './store';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const PLAYERS: PlayerId[] = ['p1', 'p2'];

/** A player who stays disconnected this long during a game, while the opponent waits, concedes. */
export const ABANDON_MS = 15 * 60_000;
/** A room nobody has been connected to for this long is deleted. */
export const IDLE_MS = 6 * 60 * 60_000;

/** Where a seat's messages go: a live socket, or nowhere while disconnected. */
export interface Outbox {
  roomState(s: RoomState): void;
  gameUpdate(u: GameUpdate): void;
}

interface Seat extends SeatRecord {
  out: Outbox | null;
  /** When the seat lost its connection (null while connected). */
  disconnectedAt: number | null;
}

/** Web Crypto (browsers and Node ≥ 19): this module runs in the server and, for serverless play, in the host's browser. */
const randomInt = (n: number): number => (crypto.getRandomValues(new Uint32Array(1))[0] as number) % n; // n ≤ 2^31: bias ≤ 2^-1, only for the seed, irrelevant
const randomToken = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Constant-time string comparison (token hashes). */
function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** How seat tokens are stored: the server hashes them (SHA-256); a browser host keeps them only in its own storage. */
export type HashToken = (token: string) => string;

export class Room {
  readonly seats: Partial<Record<PlayerId, Seat>> = {};
  state: GameState | null = null;
  version = 0;
  private seed: number | null = null;
  private inputs: PlayerInput[] = [];
  updatedAt: number;

  constructor(readonly code: string, private readonly now: () => number, private readonly hashToken: HashToken, private readonly onChange: (r: Room) => void = () => undefined) {
    this.updatedAt = now();
  }

  /** Rebuilds a stored room by replaying its inputs; every seat starts disconnected. */
  static fromRecord(r: RoomRecord, now: () => number, hashToken: HashToken, onChange?: (room: Room) => void): Room {
    const room = new Room(r.code, now, hashToken, onChange);
    for (const p of PLAYERS) {
      const s = r.seats[p];
      if (s) room.seats[p] = { ...s, out: null, disconnectedAt: now() };
    }
    room.updatedAt = r.updatedAt;
    if (r.seed !== null) {
      room.start(r.seed);
      for (const input of r.inputs) {
        const res = step(room.state as GameState, input, CARDS);
        if (!res.ok) throw new Error(`Room ${r.code}: stored input rejected on replay (${res.error})`);
        room.state = res.state;
        room.inputs.push(input);
      }
      room.version = 1 + room.inputs.length;
    }
    return room;
  }

  toRecord(): RoomRecord {
    const seats: RoomRecord['seats'] = {};
    for (const p of PLAYERS) {
      const s = this.seats[p];
      if (s) seats[p] = { name: s.name, tokenHash: s.tokenHash, deck: s.deck, fullControl: s.fullControl };
    }
    return { code: this.code, seats, seed: this.seed, inputs: this.inputs, updatedAt: this.updatedAt };
  }

  status(): RoomState['status'] {
    if (this.state?.result) return 'finished';
    if (this.state) return 'playing';
    return this.seats.p1 && this.seats.p2 ? 'choosingDecks' : 'waiting';
  }

  seatByToken(token: string): PlayerId | null {
    const h = this.hashToken(token);
    return PLAYERS.find((p) => { const s = this.seats[p]; return !!s && sameText(s.tokenHash, h); }) ?? null;
  }

  addPlayer(name: string, out: Outbox): { seat: PlayerId; token: string } | null {
    const seat = PLAYERS.find((p) => !this.seats[p]);
    if (!seat) return null;
    const token = randomToken();
    this.seats[seat] = { name, tokenHash: this.hashToken(token), out, deck: null, fullControl: false, disconnectedAt: null };
    this.changed();
    this.broadcastRoom();
    return { seat, token };
  }

  attach(seat: PlayerId, out: Outbox | null): void {
    const s = this.seats[seat];
    if (!s) return;
    s.out = out;
    s.disconnectedAt = out ? null : this.now();
    this.updatedAt = this.now();
    this.broadcastRoom();
    if (out && this.state) out.gameUpdate(this.updateFor(seat, []));
  }

  setDeck(seat: PlayerId, deck: string[]): string | null {
    if (this.state) return 'La partida ya ha empezado.';
    const errors = validateCasualDeck(deck, CARDS);
    if (errors.length) return errors.join(' ');
    (this.seats[seat] as Seat).deck = deck;
    if (this.seats.p1?.deck && this.seats.p2?.deck) {
      const error = this.start(randomInt(2 ** 31)); // seed from a CSPRNG, never sent
      if (error) return error;
    }
    this.changed();
    this.broadcastRoom();
    return null;
  }

  private start(seed: number): string | null {
    const created = createGame({ seed, decks: { p1: this.seats.p1?.deck ?? [], p2: this.seats.p2?.deck ?? [] } }, CARDS);
    if (!created.ok) return created.error;
    this.seed = seed;
    this.state = created.state;
    this.version = 1;
    this.broadcastGame(created.events);
    return null;
  }

  /** Once a game is over: back to choosing decks, keeping the room, the seats and their tokens. */
  newGame(): string | null {
    if (this.status() !== 'finished') return 'La partida todavía no ha terminado.';
    this.state = null;
    this.seed = null;
    this.inputs = [];
    this.version = 0;
    for (const p of PLAYERS) { const s = this.seats[p]; if (s) s.deck = null; }
    this.changed();
    this.broadcastRoom();
    return null;
  }

  setFullControl(seat: PlayerId, on: boolean): void {
    (this.seats[seat] as Seat).fullControl = on;
    this.changed();
    this.broadcastRoom();
  }

  input(seat: PlayerId, input: { decisionId: number; response: Response } | { concede: true }): string | null {
    if (!this.state) return 'La partida no ha empezado.';
    const first = this.apply('concede' in input ? { player: seat, concede: true } : { player: seat, ...input });
    if (typeof first === 'string') return first;
    const events = [...first, ...this.autoPass()];
    this.version = 1 + this.inputs.length; // the same number a replay reaches, so it never goes back after a restart
    this.changed();
    if (this.state.result) this.broadcastRoom();
    this.broadcastGame(events);
    return null;
  }

  /** Steps the engine and records the input; the record is what a restart replays. */
  private apply(input: PlayerInput): GameEvent[] | string {
    const r = step(this.state as GameState, input, CARDS);
    if (!r.ok) return r.error;
    this.state = r.state;
    this.inputs.push(input);
    return r.events;
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
      const r = this.apply({ player: p.player, decisionId: p.id, response: { kind: 'pass' } });
      if (typeof r === 'string') break;
      events.push(...r);
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

  /** The seat that has been away too long while the other one waits, if any. */
  abandonedSeat(now: number): PlayerId | null {
    if (this.status() !== 'playing') return null;
    const away = PLAYERS.filter((p) => this.seats[p]?.out === null);
    if (away.length !== 1) return null; // both away: nobody is waiting
    const p = away[0] as PlayerId;
    const since = this.seats[p]?.disconnectedAt ?? now;
    return now - since >= ABANDON_MS ? p : null;
  }

  idle(now: number): boolean {
    return PLAYERS.every((p) => !this.seats[p]?.out) && now - this.updatedAt >= IDLE_MS;
  }

  roomStateFor(seat: PlayerId): RoomState {
    const info = (p: PlayerId) => {
      const s = this.seats[p];
      return s ? { name: s.name, connected: s.out !== null, ready: s.deck !== null } : null;
    };
    return { code: this.code, you: seat, status: this.status(), seats: { p1: info('p1'), p2: info('p2') }, fullControl: this.seats[seat]?.fullControl ?? false };
  }

  private changed(): void {
    this.updatedAt = this.now();
    this.onChange(this);
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

/** All rooms; with a store, every change is saved and rooms survive a restart. */
export class Rooms {
  private readonly rooms = new Map<string, Room>();
  /** Saves run one after another so an older snapshot never overwrites a newer one. */
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly hashToken: HashToken, private readonly store: RoomStore | null = null, private readonly now: () => number = Date.now) {}

  static async load(hashToken: HashToken, store: RoomStore, now: () => number = Date.now): Promise<Rooms> {
    const rooms = new Rooms(hashToken, store, now);
    for (const r of await store.loadAll()) {
      try { rooms.rooms.set(r.code, Room.fromRecord(r, now, hashToken, (room) => { rooms.persist(room); })); }
      catch (e) { console.error(e); } // a room that cannot be replayed (e.g. a card definition changed) is skipped, not fatal
    }
    return rooms;
  }

  create(): Room {
    let code: string;
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    while (this.rooms.has(code));
    const room = new Room(code, this.now, this.hashToken, (r) => { this.persist(r); });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Concedes for players who abandoned a game and deletes idle rooms. Called every minute. */
  sweep(): void {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      const gone = room.abandonedSeat(now);
      if (gone) room.input(gone, { concede: true });
      if (room.idle(now)) {
        this.rooms.delete(room.code);
        const store = this.store;
        if (store) this.queue(() => store.delete(room.code));
      }
    }
  }

  /** Resolves once every queued save has finished (used by tests and on shutdown). */
  flush(): Promise<void> {
    return this.saving;
  }

  private persist(room: Room): void {
    const store = this.store;
    if (!store) return;
    const record = structuredClone(room.toRecord()); // snapshot now; the save runs later
    this.queue(() => store.save(record));
  }

  // shortcut: a crash between an input and its save loses that input; acceptable for casual games.
  private queue(task: () => Promise<void>): void {
    this.saving = this.saving.then(task).catch((e: unknown) => { console.error('Could not save a room:', e); });
  }
}
