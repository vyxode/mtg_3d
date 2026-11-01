import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sha256, startServer } from './server';
import { loadCatalog } from './api';
import { DATA_DIR } from './sync-cards';
import { PgStore, Rooms } from '@mtg3d/rooms';

const port = Number(process.env.PORT ?? 3001);
const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);
// Serve the built web app (apps/web/dist) when it exists, so one port is enough to play.
const webDir = process.env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const catalog = loadCatalog(DATA_DIR);
console.log(catalog ? `Catalog: ${String(catalog.cards.length)} cards, ${String(catalog.sets.length)} sets` : 'No card catalog yet: run `pnpm cards:sync` on a machine with internet access.');

let rooms = new Rooms(sha256);
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PgStore((text, params) => pool.query(text, params));
  await store.init();
  rooms = await Rooms.load(sha256, store);
  console.log(`Database connected: ${String(rooms.size)} room(s) restored`);
} else {
  console.log('No DATABASE_URL: rooms live in memory and are lost on restart.');
}

const server = await startServer({ port, corsOrigin: origins, webDir: existsSync(webDir) ? webDir : null, catalog, rooms });
console.log(`mtg3d server listening on ${server.url}${existsSync(webDir) ? ' (serving the web app)' : ''}`);
