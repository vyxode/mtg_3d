import { describe, expect, it } from 'vitest';
import { PRESET_DECKS } from '@mtg3d/cards';
import { openSession, Rooms } from '@mtg3d/rooms';
import type { GameUpdate, JoinAck, RoomState } from '@mtg3d/protocol';
import { Hub } from './hub';
import { guestClient, serveLink, type Link } from './link';

/** Two ends of an in-memory channel, delivering like a data channel (asynchronously, as JSON). */
function pair(): [Link, Link] {
  const handlers: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
  const closers: [(() => void)[], (() => void)[]] = [[], []];
  const end = (me: 0 | 1): Link => ({
    send: (msg) => { const copy: unknown = JSON.parse(JSON.stringify(msg)); queueMicrotask(() => { for (const h of handlers[me === 0 ? 1 : 0]) h(copy); }); },
    onMessage: (fn) => { handlers[me].push(fn); },
    onClose: (fn) => { closers[me].push(fn); },
  });
  return [end(0), end(1)];
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const deck = Object.values(PRESET_DECKS)[0] as string[];

describe('serverless play over a peer link', () => {
  it('the guest joins the host’s room, both start a game, and the guest only ever sees its own view', async () => {
    const rooms = new Rooms((t) => t);
    const hostHub = new Hub();
    const host = openSession(rooms, { roomState: (s) => { hostHub.emit('room:state', s); }, gameUpdate: (u) => { hostHub.emit('game:update', u); } });
    const created = host.handle('room:create', { name: 'Ana' }) as JoinAck;
    if (!created.ok) throw new Error(created.error);

    const [hostEnd, guestEnd] = pair();
    serveLink(rooms, hostEnd);
    const guestHub = new Hub();
    const updates: GameUpdate[] = [];
    const states: RoomState[] = [];
    guestHub.on('game:update', (u) => { updates.push(u); });
    guestHub.on('room:state', (s) => { states.push(s); });
    const ask = guestClient(guestEnd, guestHub);

    const joined = await ask('room:join', { code: created.code, name: 'Beto' }) as JoinAck;
    expect(joined).toMatchObject({ ok: true, seat: 'p2' });
    expect(await ask('room:deck', { deck })).toEqual({ ok: true });
    expect(host.handle('room:deck', { deck })).toEqual({ ok: true });
    await flush();

    expect(states.at(-1)?.status).toBe('playing');
    const last = updates.at(-1);
    expect(last?.view.viewer).toBe('p2');
    const p1Hand = rooms.get(created.code)?.state?.zones.hand.p1 ?? [];
    for (const id of p1Hand) expect(JSON.stringify(updates)).not.toContain(`"${id}"`);
  });

  it('rejects malformed messages from the guest and answers bad payloads with an error', async () => {
    const rooms = new Rooms((t) => t);
    const [hostEnd, guestEnd] = pair();
    serveLink(rooms, hostEnd);
    const answers: unknown[] = [];
    guestEnd.onMessage((m) => { answers.push(m); });
    guestEnd.send({ t: 'push', event: 'room:state', data: {} }); // guests can't push
    guestEnd.send({ t: 'ask', id: 1, event: 'room:deck', payload: { deck: 'nope' } });
    guestEnd.send({ t: 'ask', id: 2, event: 'constructor', payload: {} });
    await flush();
    expect(answers).toEqual([
      { t: 'ack', id: 1, ack: { ok: false, error: 'Mensaje no válido.' } },
      { t: 'ack', id: 2, ack: { ok: false, error: 'Mensaje no válido.' } },
    ]);
  });
});
