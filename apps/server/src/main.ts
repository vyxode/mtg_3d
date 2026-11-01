import { startServer } from './server';

const port = Number(process.env.PORT ?? 3001);
const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);
const server = await startServer(port, origins);
console.log(`mtg3d server listening on ${server.url}`);
