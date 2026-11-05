/**
 * Every card the engine can play from its Oracle data: downloads Scryfall's "Oracle cards" bulk file, compiles each card
 * with compileOracle (packages/cards/src/oracle.ts) and writes the definitions to apps/web/public/oracle.json. Only the
 * compiled rules are stored, not the cards' text. Run where Scryfall is reachable (`pnpm cards:oracle`, or the
 * "Cartas de Magic" workflow).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { compileOracle, type OracleCard } from '@mtg3d/cards';
import type { CardDef } from '@mtg3d/engine';
import { parseBulkLine } from './sync-cards';

const HEADERS = { 'User-Agent': 'mtg3d/0.1 (+https://github.com/vyxode/mtg_3d)', Accept: 'application/json;q=0.9,*/*;q=0.8' };
const OUT = fileURLToPath(new URL('../../web/public/oracle.json', import.meta.url));

export interface BulkCard extends OracleCard {
  digital?: boolean;
  set_type?: string;
  games?: string[];
  legalities?: Record<string, string>;
}

/** Paper cards legal somewhere (no Un-sets, tokens or art cards), compiled; tokens they create are added once. */
export function buildOracleDefs(cards: readonly BulkCard[]): { defs: CardDef[]; tried: number } {
  const defs = new Map<string, CardDef>();
  let tried = 0;
  for (const c of cards) {
    if (c.digital || c.set_type === 'funny' || c.set_type === 'token' || c.set_type === 'memorabilia') continue;
    if (c.games && !c.games.includes('paper')) continue;
    if (c.legalities && !Object.values(c.legalities).some((l) => l === 'legal' || l === 'restricted')) continue;
    tried++;
    const r = compileOracle(c);
    if (!r.ok) continue;
    defs.set(r.def.name, r.def);
    for (const t of r.tokens) if (!defs.has(t.name)) defs.set(t.name, t);
  }
  return { defs: [...defs.values()], tried };
}

async function main() {
  const res = await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS });
  type Entry = { type: string; uri?: string; download_uri?: string; jsonl_download_uri?: string };
  const list = await res.json() as { data?: Entry[] };
  const entry = list.data?.find((b) => b.type === 'oracle_cards');
  // The list may leave out the download links: the entry's own page has them.
  const full = entry && !entry.download_uri && !entry.jsonl_download_uri && entry.uri ? await (await fetch(entry.uri, { headers: HEADERS })).json() as Entry : entry;
  const uri = full?.jsonl_download_uri ?? full?.download_uri;
  if (!uri) throw new Error(`Scryfall bulk data (HTTP ${String(res.status)}): no download link; fields: ${Object.keys(full ?? {}).join(', ')}`);
  const file = await fetch(uri, { headers: HEADERS });
  if (!file.ok || !file.body) throw new Error(`Bulk download failed: HTTP ${String(file.status)}`);
  // One card per line (JSON Lines, or a JSON array with one card per line); gzip-compressed files are unpacked.
  const raw = Readable.fromWeb(file.body as never);
  const input = /\.gz(\?|$)/.test(uri) ? raw.pipe(createGunzip()) : raw;
  const cards: BulkCard[] = [];
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const c = parseBulkLine(line);
    if (c) cards.push(c as unknown as BulkCard);
  }
  const { defs, tried } = buildOracleDefs(cards);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), defs }));
  console.log(`${String(defs.filter((d) => !d.token).length)} of ${String(tried)} cards compiled (+${String(defs.filter((d) => d.token).length)} tokens) → ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
