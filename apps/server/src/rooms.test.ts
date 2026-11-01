import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PRESET_DECKS } from '@mtg3d/cards';
import type { GameState, PlayerId } from '@mtg3d/engine';
import { ABANDON_MS, IDLE_MS, Rooms, type Outbox, type Room } from './rooms';
import { PgStore } from './store';

const silent: Outbox = { roomState: () => undefined, gameUpdate: () => undefined };
const deck = Object.values(PRESET_DECKS)[0] as string[];

async function pgStore(): Promise<[PgStore, PGlite]> {
  const db = new PGlite();
  const store = new PgStore((text, params) => db.query(text, params));
  await store.init();
  return [store, db];
}

/** A room where both players chose decks, the starting player is chosen and both kept their hands. */
function startedRoom(rooms: Rooms): { room: Room; tokens: Record<PlayerId, string> } {
  const room = rooms.create();
  const a = room.addPlayer('Ana', silent);
  const b = room.addPlayer('Beto', silent);
  if (!a || !b) throw new Error('seats');
  expect(room.setDeck('p1', deck)).toBeNull();
  expect(room.setDeck('p2', deck)).toBeNull();
  const answer = (response: Parameters<Room['input']>[1]) => {
    const p = (room.state as GameState).pending;
    if (!p) throw new Error('no decision');
    expect(room.input(p.player, response)).toBeNull();
  };
  answer({ decisionId: (room.state as GameState).pending?.id ?? 0, response: { kind: 'chooseStartingPlayer', first: 'p1' } });
  answer({ decisionId: (room.state as GameState).pending?.id ?? 0, response: { kind: 'keep' } });
  answer({ decisionId: (room.state as GameState).pending?.id ?? 0, response: { kind: 'keep' } });
  return { room, tokens: { p1: a.token, p2: b.token } };
}

describe('room persistence', () => {
  it('a restarted server rebuilds every room from the stored inputs, and seats can be rejoined', async () => {
    const [store, db] = await pgStore();
    const rooms = new Rooms(store);
    const { room, tokens } = startedRoom(rooms);
    await rooms.flush();

    const restored = (await Rooms.load(store)).get(room.code);
    expect(restored?.state).toEqual(room.state);
    expect(restored?.version).toBe(room.version);
    expect(restored?.seatByToken(tokens.p2)).toBe('p2');
    expect(restored?.seatByToken('not-a-token')).toBeNull();
    expect(restored?.roomStateFor('p1').seats.p1?.connected).toBe(false);

    const raw = JSON.stringify((await db.query('SELECT data FROM rooms')).rows);
    expect(raw).not.toContain(tokens.p1); // only token hashes are stored
  });
});

describe('abandoned and idle rooms', () => {
  it('a player away for too long during a game concedes, but not while both are away', () => {
    let now = 1_000_000;
    const rooms = new Rooms(null, () => now);
    const { room } = startedRoom(rooms);
    room.attach('p2', null);
    now += ABANDON_MS - 1;
    rooms.sweep();
    expect(room.state?.result).toBeNull();
    now += 1;
    rooms.sweep();
    expect(room.state?.result).toEqual({ winner: 'p1', reason: 'opponentLost' });

    const other = startedRoom(rooms).room;
    other.attach('p1', null);
    other.attach('p2', null);
    now += ABANDON_MS * 2;
    rooms.sweep();
    expect(other.state?.result).toBeNull();
  });

  it('rooms nobody has used for hours are deleted, from the database too', async () => {
    const [store] = await pgStore();
    let now = 5_000_000;
    const rooms = new Rooms(store, () => now);
    const room = rooms.create();
    room.addPlayer('Ana', silent);
    room.attach('p1', null);
    now += IDLE_MS;
    rooms.sweep();
    await rooms.flush();
    expect(rooms.get(room.code)).toBeUndefined();
    expect(await store.loadAll()).toEqual([]);
  });
});
