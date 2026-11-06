/**
 * Spanish printings of every card the engine can play (hand-written and compiled from Oracle data): name, type line,
 * rules text and image, from Scryfall. Walks every Spanish printing once (newest first) and writes
 * apps/web/public/es.json, loaded when the app starts. Run where Scryfall is reachable (`pnpm cards:es`, or the
 * "Cartas de Magic" workflow, after the Oracle compile). Cards never printed in Spanish show in English.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFS, type EsCard } from '@mtg3d/cards';
import type { CardDef } from '@mtg3d/engine';

const API = 'https://api.scryfall.com';
const HEADERS = { 'User-Agent': 'mtg3d/0.1 (+https://github.com/vyxode/mtg_3d)', Accept: 'application/json;q=0.9,*/*;q=0.8' };
const PUBLIC = new URL('../../web/public/', import.meta.url);
const OUT = fileURLToPath(new URL('es.json', PUBLIC));
const ORACLE = fileURLToPath(new URL('oracle.json', PUBLIC));

interface Face { name: string; printed_name?: string; printed_type_line?: string; printed_text?: string; image_uris?: { normal: string } }
export interface ScryCard extends Face { lang: string; card_faces?: Face[] }

/** One entry per face, keyed by the English face name the engine uses. */
export function entriesOf(card: ScryCard): [string, EsCard][] {
  const faces = card.card_faces?.length ? card.card_faces : [card];
  return faces.map((f) => [f.name, {
    name: f.printed_name ?? f.name,
    type: f.printed_type_line ?? '',
    text: f.printed_text ?? '',
    image: f.image_uris?.normal ?? card.image_uris?.normal ?? null,
  }]);
}

/** Keeps, for each wanted English face name, the first printing that has its name printed in Spanish (pages come newest first). */
export function pickSpanish(cards: readonly ScryCard[], wanted: ReadonlySet<string>, out: Record<string, EsCard>): void {
  for (const card of cards) {
    if (card.lang !== 'es') continue;
    for (const [k, v] of entriesOf(card)) {
      if (!wanted.has(k) || out[k]) continue;
      if (v.name === k && v.type === '') continue; // an entry with only the English data: wait for a translated printing
      out[k] = v;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function page(url: string, attempt = 1): Promise<{ data: ScryCard[]; has_more: boolean; next_page?: string }> {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 429 && attempt < 6) { // too many requests: wait as asked, then try again
    await sleep(Number(res.headers.get('retry-after') ?? '0') * 1000 || 2000 * attempt);
    return page(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${String(res.status)}`);
  return (await res.json()) as { data: ScryCard[]; has_more: boolean; next_page?: string };
}

async function main(): Promise<void> {
  const compiled = existsSync(ORACLE) ? (JSON.parse(readFileSync(ORACLE, 'utf8')) as { defs: CardDef[] }).defs : [];
  const wanted = new Set([...DEFS, ...compiled].map((d) => d.name));
  const out: Record<string, EsCard> = {};
  let url: string | undefined = `${API}/cards/search?q=${encodeURIComponent('lang:es')}&unique=prints&order=released&dir=desc&include_extras=true`;
  let pages = 0;
  while (url) {
    const body = await page(url);
    pickSpanish(body.data, wanted, out);
    url = body.has_more ? body.next_page : undefined;
    pages++;
    await sleep(150); // Scryfall asks for 50–100 ms between requests; searches a little more
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  writeFileSync(OUT, JSON.stringify(sorted));
  console.log(`${String(Object.keys(out).length)} of ${String(wanted.size)} cards in Spanish (${String(pages)} pages) → ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
