/** Card catalog built from Scryfall bulk data, held in memory and searched with simple filters. */

export interface Printing { id: string; set: string; setName: string; collectorNumber: string; rarity: string; releasedAt: string; image: string | null }
export interface Face { name: string; manaCost: string; typeLine: string; oracleText: string; image: string | null }

export interface CatalogCard {
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  colors: string[];
  colorIdentity: string[];
  power?: string;
  toughness?: string;
  loyalty?: string;
  layout: string;
  legalities: Record<string, string>;
  faces: Face[];
  printings: Printing[];
}

export interface SetInfo { code: string; name: string; releasedAt: string; setType: string; cardCount: number; icon: string | null; digital: boolean }

/** The subset of a Scryfall card object we read. */
export interface RawCard {
  oracle_id?: string; id: string; name: string; layout: string; lang?: string;
  mana_cost?: string; cmc?: number; type_line?: string; oracle_text?: string;
  colors?: string[]; color_identity?: string[]; power?: string; toughness?: string; loyalty?: string;
  legalities?: Record<string, string>; set: string; set_name: string; collector_number: string; rarity: string; released_at: string;
  digital?: boolean; image_uris?: { normal?: string };
  card_faces?: { name: string; mana_cost?: string; type_line?: string; oracle_text?: string; colors?: string[]; oracle_id?: string; image_uris?: { normal?: string } }[];
}

const imageOf = (c: RawCard): string | null => c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null;

/** Groups printings (one Scryfall object each) into one entry per Oracle card, one object at a time. */
export function catalogBuilder(): { add(c: RawCard): void; finish(): CatalogCard[] } {
  const byOracle = new Map<string, CatalogCard>();
  return { add: (c) => { addPrinting(byOracle, c); }, finish: () => finishCatalog(byOracle) };
}

export function buildCatalog(raw: Iterable<RawCard>): CatalogCard[] {
  const b = catalogBuilder();
  for (const c of raw) b.add(c);
  return b.finish();
}

function addPrinting(byOracle: Map<string, CatalogCard>, c: RawCard): void {
  {
    const oracleId = c.oracle_id ?? c.card_faces?.[0]?.oracle_id; // reversible cards keep it on their faces
    if (!oracleId || c.digital) return; // digital-only printings (Alchemy) are excluded by default
    const printing: Printing = { id: c.id, set: c.set, setName: c.set_name, collectorNumber: c.collector_number, rarity: c.rarity, releasedAt: c.released_at, image: imageOf(c) };
    const existing = byOracle.get(oracleId);
    if (existing) { existing.printings.push(printing); return; }
    const faces = (c.card_faces ?? []).map((f) => ({ name: f.name, manaCost: f.mana_cost ?? '', typeLine: f.type_line ?? '', oracleText: f.oracle_text ?? '', image: f.image_uris?.normal ?? null }));
    byOracle.set(oracleId, {
      oracleId, name: c.name, manaCost: c.mana_cost ?? faces[0]?.manaCost ?? '', cmc: c.cmc ?? 0,
      typeLine: c.type_line ?? '', oracleText: c.oracle_text ?? faces.map((f) => f.oracleText).join('\n//\n'),
      colors: c.colors ?? c.card_faces?.[0]?.colors ?? [], colorIdentity: c.color_identity ?? [],
      ...(c.power !== undefined && { power: c.power }), ...(c.toughness !== undefined && { toughness: c.toughness }), ...(c.loyalty !== undefined && { loyalty: c.loyalty }),
      layout: c.layout, legalities: c.legalities ?? {}, faces, printings: [printing],
    });
  }
}

function finishCatalog(byOracle: Map<string, CatalogCard>): CatalogCard[] {
  const cards = [...byOracle.values()];
  for (const card of cards) card.printings.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  return cards.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CardQuery {
  name?: string; text?: string; type?: string;
  /** Card must include all these colors ("c" = colorless). */
  colors?: string[];
  /** Color identity must be within these colors. */
  identity?: string[];
  cmc?: number; cmcOp?: 'eq' | 'lte' | 'gte';
  power?: string; toughness?: string;
  set?: string; rarity?: string; format?: string;
  page?: number;
}

export const PAGE_SIZE = 60;

/** Strips accents and case so "cuarto" matches "Cuárto". */
const norm = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function searchCatalog(cards: readonly CatalogCard[], q: CardQuery): { total: number; page: number; cards: CatalogCard[] } {
  const name = q.name ? norm(q.name) : null;
  const text = q.text ? norm(q.text) : null;
  const type = q.type ? norm(q.type) : null;
  const matches = cards.filter((c) => {
    if (name && !norm(c.name).includes(name)) return false;
    if (text && !norm(c.oracleText).includes(text)) return false;
    if (type && !norm(c.typeLine).includes(type)) return false;
    if (q.colors?.length) {
      if (q.colors.includes('c') ? c.colors.length > 0 : !q.colors.every((x) => c.colors.includes(x))) return false;
    }
    if (q.identity && !c.colorIdentity.every((x) => q.identity?.includes(x))) return false;
    if (q.cmc !== undefined) {
      const op = q.cmcOp ?? 'eq';
      if (op === 'eq' ? c.cmc !== q.cmc : op === 'lte' ? c.cmc > q.cmc : c.cmc < q.cmc) return false;
    }
    if (q.power !== undefined && c.power !== q.power) return false;
    if (q.toughness !== undefined && c.toughness !== q.toughness) return false;
    if (q.set && !c.printings.some((p) => p.set === q.set)) return false;
    if (q.rarity && !c.printings.some((p) => p.rarity === q.rarity)) return false;
    if (q.format && c.legalities[q.format] !== 'legal' && c.legalities[q.format] !== 'restricted') return false;
    return true;
  });
  const page = Math.max(0, q.page ?? 0);
  return { total: matches.length, page, cards: matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
}
