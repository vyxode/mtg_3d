/**
 * Downloads Scryfall's bulk card data and writes data/catalog.json and data/sets.json.
 * Run on a machine with internet access: `pnpm cards:sync`. Skips the download when Scryfall has nothing newer.
 * Follows Scryfall's API guidelines: identifying User-Agent and Accept headers, a pause between API calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { catalogBuilder, type RawCard, type SetInfo } from './catalog';

const API = 'https://api.scryfall.com';
const HEADERS = { 'User-Agent': 'mtg3d/0.1 (+https://github.com/vyxode/mtg_3d)', Accept: 'application/json;q=0.9,*/*;q=0.8' };
export const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url));

/** Bulk files hold one card object per line inside a JSON array (and JSON Lines has one per line, too). */
export function parseBulkLine(line: string): RawCard | null {
  const t = line.trim().replace(/,$/, '');
  if (t === '' || t === '[' || t === ']') return null;
  return JSON.parse(t) as RawCard;
}

const pause = () => new Promise((r) => setTimeout(r, 100)); // 50–100 ms between API requests

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: HTTP ${String(res.status)}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const metaPath = join(DATA_DIR, 'meta.json');
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { updatedAt?: string }) : {};

  const bulk = await getJson<{ data: { type: string; updated_at: string; download_uri: string }[] }>(`${API}/bulk-data`);
  const entry = bulk.data.find((b) => b.type === 'default_cards');
  if (!entry) throw new Error('Scryfall did not list a default_cards bulk file');
  if (meta.updatedAt === entry.updated_at && existsSync(join(DATA_DIR, 'catalog.json'))) {
    console.log(`Catalog already up to date (${entry.updated_at}).`);
    return;
  }

  console.log(`Downloading ${entry.download_uri} …`);
  const res = await fetch(entry.download_uri, { headers: HEADERS }); // *.scryfall.io: no rate limit
  if (!res.ok || !res.body) throw new Error(`Bulk download failed: HTTP ${String(res.status)}`);
  const builder = catalogBuilder();
  let n = 0;
  const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  for await (const line of lines) {
    const card = parseBulkLine(line);
    if (!card) continue;
    builder.add(card);
    if (++n % 20000 === 0) console.log(`  ${String(n)} printings…`);
  }
  const catalog = builder.finish();

  await pause();
  const sets = await getJson<{ data: { code: string; name: string; released_at?: string; set_type: string; card_count: number; icon_svg_uri?: string; digital: boolean }[] }>(`${API}/sets`);
  const setInfo: SetInfo[] = sets.data.map((s) => ({ code: s.code, name: s.name, releasedAt: s.released_at ?? '', setType: s.set_type, cardCount: s.card_count, icon: s.icon_svg_uri ?? null, digital: s.digital }));

  writeFileSync(join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(DATA_DIR, 'sets.json'), JSON.stringify(setInfo));
  writeFileSync(metaPath, JSON.stringify({ updatedAt: entry.updated_at }));
  console.log(`Wrote ${String(catalog.length)} cards from ${String(n)} printings and ${String(setInfo.length)} sets to ${DATA_DIR}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
