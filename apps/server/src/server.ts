import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import { createHash } from 'node:crypto';
import { clientMessages, type ClientToServer, type ServerToClient } from '@mtg3d/protocol';
import { openSession, Rooms, type HashToken } from '@mtg3d/rooms';
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

/** Seat tokens are stored hashed: a leaked database does not let anyone take a seat. */
export const sha256: HashToken = (token) => createHash('sha256').update(token).digest('hex');

export async function startServer({ port = 0, corsOrigin = [], webDir = null, catalog = null, rooms = new Rooms(sha256) }: ServerOptions = {}): Promise<RunningServer> {
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
    const session = openSession(rooms, {
      roomState: (s) => socket.emit('room:state', s),
      gameUpdate: (u) => socket.emit('game:update', u),
    });
    for (const event of Object.keys(clientMessages)) {
      socket.on(event as never, (payload: unknown, ack: unknown) => {
        if (typeof ack === 'function') (ack as (a: unknown) => void)(session.handle(event, payload));
      });
    }
    socket.on('disconnect', () => { session.close(); });
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
