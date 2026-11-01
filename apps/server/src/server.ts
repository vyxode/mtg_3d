import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import { clientMessages, type Ack, type ClientMessage, type ClientToServer, type ServerToClient } from '@mtg3d/protocol';
import type { PlayerId } from '@mtg3d/engine';
import { Rooms, type Outbox, type Room } from './rooms';
import { staticHandler } from './static';
import { apiHandler, type Catalog } from './api';

type GameSocket = Socket<ClientToServer, ServerToClient>;

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export interface ServerOptions {
  port?: number;
  corsOrigin?: string[];
  /** Built web app to serve, if any. */
  webDir?: string | null;
  catalog?: Catalog | null;
  /** Rooms (restored from the database, or in memory only). */
  rooms?: Rooms;
}

const SWEEP_MS = 60_000;

export async function startServer({ port = 0, corsOrigin = [], webDir = null, catalog = null, rooms = new Rooms() }: ServerOptions = {}): Promise<RunningServer> {
  const serve = webDir ? staticHandler(webDir) : null;
  const api = apiHandler(catalog);
  const http = createHttpServer((req, res) => {
    if (api(req, res)) return;
    if (serve) void serve(req, res); else res.writeHead(404).end();
  });
  const io = new Server<ClientToServer, ServerToClient>(http, { cors: { origin: corsOrigin } });
  const sweeper = setInterval(() => { rooms.sweep(); }, SWEEP_MS);
  sweeper.unref();

  io.on('connection', (socket: GameSocket) => {
    let room: Room | null = null;
    let seat: PlayerId | null = null;
    const out: Outbox = {
      roomState: (s) => socket.emit('room:state', s),
      gameUpdate: (u) => socket.emit('game:update', u),
    };

    /** Validates the payload at the trust boundary and turns any failure into an error ack. */
    function on(event: ClientMessage, handler: (payload: never) => Ack | Promise<Ack>): void {
      socket.on(event as never, async (payload: unknown, ack: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (a: Ack) => void) : () => undefined;
        const parsed = clientMessages[event].safeParse(payload);
        if (!parsed.success) { reply({ ok: false, error: 'Mensaje no válido.' }); return; }
        try { reply(await handler(parsed.data as never)); }
        catch (e) { console.error(e); reply({ ok: false, error: 'Error interno del servidor.' }); }
      });
    }

    const join = (r: Room, s: PlayerId, token: string) => {
      room = r; seat = s;
      r.attach(s, out);
      return { ok: true as const, code: r.code, seat: s, token };
    };

    on('room:create', ({ name }: { name: string }) => {
      if (room) return { ok: false, error: 'Ya estás en una sala.' };
      const r = rooms.create();
      const added = r.addPlayer(name, out);
      if (!added) return { ok: false, error: 'No se pudo crear la sala.' };
      return join(r, added.seat, added.token);
    });

    on('room:join', ({ code, name }: { code: string; name: string }) => {
      if (room) return { ok: false, error: 'Ya estás en una sala.' };
      const r = rooms.get(code);
      if (!r) return { ok: false, error: 'No existe ninguna sala con ese código.' };
      const added = r.addPlayer(name, out);
      if (!added) return { ok: false, error: 'La sala está llena.' };
      return join(r, added.seat, added.token);
    });

    on('room:rejoin', ({ code, token }: { code: string; token: string }) => {
      const r = rooms.get(code);
      const s = r?.seatByToken(token) ?? null;
      if (!r || !s) return { ok: false, error: 'No se pudo volver a la sala.' };
      return join(r, s, token);
    });

    on('room:deck', ({ deck }: { deck: string[] }) => {
      if (!room || !seat) return { ok: false, error: 'No estás en una sala.' };
      const error = room.setDeck(seat, deck);
      return error ? { ok: false, error } : { ok: true };
    });

    on('room:settings', ({ fullControl }: { fullControl: boolean }) => {
      if (!room || !seat) return { ok: false, error: 'No estás en una sala.' };
      room.setFullControl(seat, fullControl);
      return { ok: true };
    });

    on('game:input', (input: Parameters<Room['input']>[1]) => {
      if (!room || !seat) return { ok: false, error: 'No estás en una sala.' };
      const error = room.input(seat, input);
      return error ? { ok: false, error } : { ok: true };
    });

    socket.on('disconnect', () => {
      // Only detach if this socket is still the seat's current connection (a rejoin may have replaced it).
      if (room && seat && room.seats[seat]?.out === out) room.attach(seat, null);
    });
  });

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const { port: actual } = http.address() as AddressInfo;
  return {
    url: `http://localhost:${String(actual)}`,
    close: async () => {
      clearInterval(sweeper);
      await new Promise<void>((resolve) => { void io.close(() => { resolve(); }); });
      await rooms.flush();
    },
  };
}
