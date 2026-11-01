import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 3001);
const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);
// Serve the built web app (apps/web/dist) when it exists, so one port is enough to play.
const webDir = process.env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const server = await startServer(port, origins, existsSync(webDir) ? webDir : null);
console.log(`mtg3d server listening on ${server.url}${existsSync(webDir) ? ' (serving the web app)' : ''}`);
