import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { PRESET_DECKS } from '@mtg3d/cards';
import type { ClientToServer, GameUpdate, JoinAck, RoomState, ServerToClient } from '@mtg3d/protocol';
import { startServer, type RunningServer } from './server';

type Client = Socket<ServerToClient, ClientToServer> & { last?: GameUpdate; room?: RoomState };

let server: RunningServer;
const clients: Client[] = [];

beforeEach(async () => { server = await startServer(0); });
afterEach(async () => { for (const c of clients.splice(0)) c.disconnect(); await server.close(); });

function client(): Promise<Client> {
  const c: Client = connect(server.url, { transports: ['websocket'], forceNew: true });
  c.on('game:update', (u) => { c.last = u; });
  c.on('room:state', (s) => { c.room = s; });
  clients.push(c);
  return new Promise((resolve) => c.on('connect', () => { resolve(c); }));
}

const ask = <T>(c: Client, event: keyof ClientToServer, payload: unknown): Promise<T> =>
  new Promise((resolve) => { (c.emit as (e: string, p: unknown, a: (r: T) => void) => void)(event, payload, resolve); });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
}

const [deckA, deckB] = Object.values(PRESET_DECKS) as [string[], string[]];

async function startedGame() {
  const a = await client();
  const b = await client();
  const created = await ask<JoinAck>(a, 'room:create', { name: 'Ana' });
  if (!created.ok) throw new Error(created.error);
  const joined = await ask<JoinAck>(b, 'room:join', { code: created.code.toLowerCase(), name: 'Beto' });
  if (!joined.ok) throw new Error(joined.error);
  expect(await ask(a, 'room:deck', { deck: deckA })).toEqual({ ok: true });
  expect(await ask(b, 'room:deck', { deck: deckB })).toEqual({ ok: true });
  await until(() => !!a.last && !!b.last);
  return { a, b, code: created.code, tokenB: joined.token };
}

/** Answers whatever decision is pending for whoever holds it, with the simplest choice. */
async function answer(a: Client, b: Client) {
  const view = (a.last as GameUpdate).view;
  const p = view.pending;
  if (!p) throw new Error('nothing pending');
  const who = p.player === 'p1' ? a : b;
  const mine = (who.last as GameUpdate).view.pending as NonNullable<GameUpdate['view']['pending']>;
  const response = mine.kind === 'chooseStartingPlayer' ? { kind: 'chooseStartingPlayer', first: 'p1' } : mine.kind === 'mulligan' ? { kind: 'keep' } : { kind: 'pass' };
  const before = (a.last as GameUpdate).version;
  expect(await ask(who, 'game:input', { decisionId: mine.id, response })).toEqual({ ok: true });
  await until(() => (a.last as GameUpdate).version > before && (b.last as GameUpdate).version > before);
}

describe('server', () => {
  it('creates a room, joins by code, starts a game when both decks are chosen and plays into turn 1', async () => {
    const { a, b } = await startedGame();
    expect(a.room?.status).toBe('playing');
    expect(a.room?.seats.p2?.name).toBe('Beto');
    for (let i = 0; i < 3; i++) await answer(a, b); // choose starting player, two keeps
    const va = (a.last as GameUpdate).view;
    expect(va.turn.number).toBe(1);
    expect(va.turn.step).toBe('main1'); // auto-pass skipped upkeep and draw: nothing could be played there
    expect(va.pending).toMatchObject({ kind: 'priority', player: 'p1' });
    expect(va.zones.hand).toHaveLength(7);
    expect(va.players.p2.handSize).toBe(7);
  });

  it('never sends a player the ids of the opponent hand or of any library', async () => {
    const { a, b } = await startedGame();
    for (let i = 0; i < 3; i++) await answer(a, b);
    const handA = (a.last as GameUpdate).view.zones.hand;
    const sentToB = JSON.stringify(b.last);
    for (const id of handA) expect(sentToB).not.toContain(`"${id}"`);
    expect((b.last as GameUpdate).view.objects).not.toHaveProperty(handA[0] as string);
  });

  it('rejects malformed messages, answers out of turn and illegal decks', async () => {
    const { a, b } = await startedGame();
    expect(await ask(a, 'game:input', { decisionId: 'x', response: { kind: 'explode' } })).toEqual({ ok: false, error: 'Mensaje no válido.' });
    const p = (a.last as GameUpdate).view.pending as { player: string; id: number };
    const wrong = p.player === 'p1' ? b : a;
    expect(await ask(wrong, 'game:input', { decisionId: p.id, response: { kind: 'pass' } })).toMatchObject({ ok: false });
    const c = await client();
    expect(await ask(c, 'room:deck', { deck: deckA })).toMatchObject({ ok: false });
  });

  it('refuses a third player', async () => {
    const { code } = await startedGame();
    const c = await client();
    expect(await ask(c, 'room:join', { code, name: 'Cata' })).toEqual({ ok: false, error: 'La sala está llena.' });
  });

  it('reconnects a player with their token and resends the current view', async () => {
    const { a, b, code, tokenB } = await startedGame();
    for (let i = 0; i < 3; i++) await answer(a, b);
    const version = (b.last as GameUpdate).version;
    b.disconnect();
    await until(() => a.room?.seats.p2?.connected === false);

    const b2 = await client();
    const rejoined = await ask<JoinAck>(b2, 'room:rejoin', { code, token: tokenB });
    expect(rejoined).toMatchObject({ ok: true, seat: 'p2' });
    await until(() => !!b2.last);
    expect((b2.last as GameUpdate).version).toBe(version);
    expect((b2.last as GameUpdate).view.zones.hand).toHaveLength(7);
    await until(() => a.room?.seats.p2?.connected === true);
    const intruder = await client();
    expect(await ask(intruder, 'room:rejoin', { code, token: 'x'.repeat(32) })).toEqual({ ok: false, error: 'No se pudo volver a la sala.' });
  });
});
