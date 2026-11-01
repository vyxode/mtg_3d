import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { searchCatalog, PAGE_SIZE, type CatalogCard, type SetInfo } from './catalog';

export interface Catalog { cards: CatalogCard[]; sets: SetInfo[]; byId: Map<string, CatalogCard> }

export function loadCatalog(dataDir: string): Catalog | null {
  const cardsPath = join(dataDir, 'catalog.json');
  if (!existsSync(cardsPath)) return null;
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8')) as CatalogCard[];
  const setsPath = join(dataDir, 'sets.json');
  const sets = existsSync(setsPath) ? (JSON.parse(readFileSync(setsPath, 'utf8')) as SetInfo[]) : [];
  return { cards, sets, byId: new Map(cards.map((c) => [c.oracleId, c])) };
}

const str = z.string().trim().min(1).max(100).optional();
const list = z.string().max(20).optional().transform((v) => (v ? v.split(',').filter(Boolean) : undefined));
const querySchema = z.object({
  name: str, text: str, type: str, colors: list, identity: list,
  cmc: z.coerce.number().int().min(0).max(30).optional(), cmcOp: z.enum(['eq', 'lte', 'gte']).optional(),
  power: z.string().max(5).optional(), toughness: z.string().max(5).optional(),
  set: z.string().max(10).optional(), rarity: z.enum(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']).optional(),
  format: z.string().max(20).optional(), page: z.coerce.number().int().min(0).max(10000).optional(),
});

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' }).end(JSON.stringify(body));
};

/** Handles /api/*; returns false for any other path. */
export function apiHandler(catalog: Catalog | null) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    if (req.method !== 'GET') { send(res, 405, { error: 'Método no permitido' }); return true; }
    if (url.pathname === '/api/status') { send(res, 200, { cards: catalog?.cards.length ?? 0, sets: catalog?.sets.length ?? 0 }); return true; }
    if (!catalog) { send(res, 503, { error: 'El catálogo no está cargado: ejecuta pnpm cards:sync en una máquina con internet.' }); return true; }
    if (url.pathname === '/api/sets') { send(res, 200, catalog.sets); return true; }
    if (url.pathname === '/api/cards') {
      const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) { send(res, 400, { error: 'Parámetros de búsqueda no válidos' }); return true; }
      const q = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
      const r = searchCatalog(catalog.cards, q);
      // Lists carry only the newest printing; the detail endpoint has them all.
      send(res, 200, { ...r, pageSize: PAGE_SIZE, cards: r.cards.map((c) => ({ ...c, printings: c.printings.slice(0, 1), printingCount: c.printings.length })) });
      return true;
    }
    const m = /^\/api\/cards\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (m) {
      const card = catalog.byId.get(m[1] as string);
      if (card) send(res, 200, card); else send(res, 404, { error: 'Carta no encontrada' });
      return true;
    }
    send(res, 404, { error: 'No encontrado' });
    return true;
  };
}
