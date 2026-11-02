import { clientMessages, type Ack, type ClientMessage, type ClientPayload, type JoinAck } from '@mtg3d/protocol';
import type { PlayerId } from '@mtg3d/engine';
import type { Outbox, Room, Rooms } from './rooms';

/** One client's connection to the rooms, whatever carries it (Socket.IO on the server, WebRTC in a browser host). */
export interface Session {
  /** Validates the payload at the trust boundary and answers; never throws. */
  handle(event: string, payload: unknown): Ack | JoinAck;
  /** The connection is gone: the seat shows as disconnected (unless a newer connection took it over). */
  close(): void;
}

export function openSession(rooms: Rooms, out: Outbox): Session {
  let room: Room | null = null;
  let seat: PlayerId | null = null;
  const notIn: Ack = { ok: false, error: 'No estás en una sala.' };

  const join = (r: Room, s: PlayerId, token: string): JoinAck => {
    room = r; seat = s;
    r.attach(s, out);
    return { ok: true, code: r.code, seat: s, token };
  };

  const handlers: { [K in ClientMessage]: (p: ClientPayload<K>) => Ack | JoinAck } = {
    'room:create': ({ name }) => {
      if (room) return { ok: false, error: 'Ya estás en una sala.' };
      const r = rooms.create();
      const added = r.addPlayer(name, out);
      return added ? join(r, added.seat, added.token) : { ok: false, error: 'No se pudo crear la sala.' };
    },
    'room:join': ({ code, name }) => {
      if (room) return { ok: false, error: 'Ya estás en una sala.' };
      const r = rooms.get(code);
      if (!r) return { ok: false, error: 'No existe ninguna sala con ese código.' };
      const added = r.addPlayer(name, out);
      return added ? join(r, added.seat, added.token) : { ok: false, error: 'La sala está llena.' };
    },
    'room:rejoin': ({ code, token }) => {
      const r = rooms.get(code);
      const s = r?.seatByToken(token) ?? null;
      return r && s ? join(r, s, token) : { ok: false, error: 'No se pudo volver a la sala.' };
    },
    'room:deck': ({ deck }) => {
      if (!room || !seat) return notIn;
      const error = room.setDeck(seat, deck);
      return error ? { ok: false, error } : { ok: true };
    },
    'room:newGame': () => {
      if (!room || !seat) return notIn;
      const error = room.newGame();
      return error ? { ok: false, error } : { ok: true };
    },
    'room:settings': ({ fullControl }) => {
      if (!room || !seat) return notIn;
      room.setFullControl(seat, fullControl);
      return { ok: true };
    },
    'game:input': (input) => {
      if (!room || !seat) return notIn;
      const error = room.input(seat, input);
      return error ? { ok: false, error } : { ok: true };
    },
  };

  return {
    handle(event, payload) {
      if (!Object.hasOwn(clientMessages, event)) return { ok: false, error: 'Mensaje no válido.' };
      const name = event as ClientMessage;
      const parsed = clientMessages[name].safeParse(payload);
      if (!parsed.success) return { ok: false, error: 'Mensaje no válido.' };
      try { return (handlers[name] as (p: unknown) => Ack | JoinAck)(parsed.data); }
      catch (e) { console.error(e); return { ok: false, error: 'Error interno.' }; }
    },
    close() {
      // Only detach if this connection is still the seat's current one (a rejoin may have replaced it).
      if (room && seat && room.seats[seat]?.out === out) room.attach(seat, null);
    },
  };
}
