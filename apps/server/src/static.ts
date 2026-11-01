import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

/** Serves the built web app from `root`; unknown paths get index.html (single-page app). */
export function staticHandler(root: string) {
  const base = resolve(root);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let path: string;
    try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    const file = resolve(join(base, path));
    const inside = file === base || file.startsWith(base + sep); // blocks ../ traversal, encoded or not
    const target = inside && extname(file) ? file : join(base, 'index.html');
    try {
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  };
}
