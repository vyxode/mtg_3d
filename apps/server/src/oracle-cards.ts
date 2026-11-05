/**
 * Every card the engine can play from its Oracle data: downloads Scryfall's "Oracle cards" bulk file, compiles each card
 * with compileOracle (packages/cards/src/oracle.ts) and writes the definitions to apps/web/public/oracle.json. Only the
 * compiled rules are stored, not the cards' text. Run where Scryfall is reachable (`pnpm cards:oracle`, or the
 * "Cartas de Magic" workflow).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileOracle, type OracleCard } from '@mtg3d/cards';
import type { CardDef } from '@mtg3d/engine';

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
  const list = await res.json() as { data?: { type: string; download_uri: string }[] };
  const uri = list.data?.find((b) => b.type === 'oracle_cards')?.download_uri;
  if (!uri) throw new Error(`Scryfall bulk data (HTTP ${String(res.status)}): ${JSON.stringify(list).slice(0, 300)}`);
  const cards = await (await fetch(uri, { headers: HEADERS })).json() as BulkCard[];
  const { defs, tried } = buildOracleDefs(cards);
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), defs }));
  console.log(`${String(defs.filter((d) => !d.token).length)} of ${String(tried)} cards compiled (+${String(defs.filter((d) => d.token).length)} tokens) → ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
