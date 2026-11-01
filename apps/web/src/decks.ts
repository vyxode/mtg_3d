import type { CardRegistry } from '@mtg3d/engine';

/** What a deck remembers about each card, so stats work without the server. */
export interface DeckCard {
  name: string;
  cmc: number;
  typeLine: string;
  manaCost: string;
  image: string | null;
  legalities: Record<string, string>;
  /** "A deck can have any number of cards named …" (100.2a exception). */
  anyNumber: boolean;
}

export interface Deck {
  id: string;
  name: string;
  format: Format;
  main: Record<string, number>;
  side: Record<string, number>;
  info: Record<string, DeckCard>;
  updatedAt: string;
}

export const FORMATS = ['casual', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper'] as const;
export type Format = (typeof FORMATS)[number];

const KEY = 'mtg3d.decks';

// shortcut: decks live in this browser's storage; they move to the server (PostgreSQL) with accounts in phase G.
export function loadDecks(): Deck[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Deck[]; } catch { return []; }
}
export function saveDecks(decks: Deck[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(decks)); } catch { /* storage full or blocked: nothing else to do */ }
}

export const newDeck = (name = 'Mazo nuevo'): Deck => ({ id: crypto.randomUUID(), name, format: 'casual', main: {}, side: {}, info: {}, updatedAt: new Date().toISOString() });

/** Every card name once per copy: what the server receives. */
export const expandList = (counts: Record<string, number>): string[] => Object.entries(counts).flatMap(([n, k]) => Array<string>(k).fill(n));
export const countOf = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

/** Parses "4 Lightning Bolt", "4x Lightning Bolt (M10) 146", a "Sideboard" line or "SB: 2 Negate". */
export function parseDeckText(text: string): { main: Record<string, number>; side: Record<string, number>; errors: string[] } {
  const main: Record<string, number> = {};
  const side: Record<string, number> = {};
  const errors: string[] = [];
  let target = main;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || /^deck$/i.test(line)) continue;
    if (/^(sideboard|banquillo)\s*:?$/i.test(line)) { target = side; continue; }
    let into = target;
    if (/^sb:\s*/i.test(line)) { line = line.replace(/^sb:\s*/i, ''); into = side; }
    const m = /^(\d+)\s*x?\s+(.+?)(\s+\([A-Za-z0-9]+\)(\s+\S+)?)?$/.exec(line);
    if (!m) { errors.push(`No entiendo la línea: «${raw.trim()}»`); continue; }
    const name = frontName((m[2] as string).trim());
    into[name] = (into[name] ?? 0) + Number(m[1]);
  }
  return { main, side, errors };
}

/** A double-faced card is listed by its front face ("Esper Origins // Summon: Esper Maduin" → "Esper Origins"), as Arena and MTGO do. */
export const frontName = (name: string): string => name.split(' // ')[0] ?? name;

export function exportDeckText(d: Deck): string {
  const lines = (c: Record<string, number>) => Object.entries(c).map(([n, k]) => `${String(k)} ${n}`);
  const side = lines(d.side);
  return [...lines(d.main), ...(side.length ? ['', 'Sideboard', ...side] : [])].join('\n');
}

const isBasic = (c: DeckCard | undefined) => !!c && /\bBasic\b/.test(c.typeLine) && /\bLand\b/.test(c.typeLine);

/** Construction rules (100.2a, 100.4a) and format legality; plus whether the engine can play every card. */
export function validateDeck(d: Deck, reg: CardRegistry): { errors: string[]; unplayable: string[] } {
  const errors: string[] = [];
  const total = countOf(d.main);
  if (total < 60) errors.push(`El mazo principal tiene ${String(total)} cartas; el mínimo es 60.`);
  if (countOf(d.side) > 15) errors.push(`El banquillo tiene ${String(countOf(d.side))} cartas; el máximo es 15.`);
  const both: Record<string, number> = { ...d.main };
  for (const [n, k] of Object.entries(d.side)) both[n] = (both[n] ?? 0) + k;
  for (const [name, n] of Object.entries(both)) {
    const info = d.info[name];
    const limit = d.format === 'vintage' && info?.legalities.vintage === 'restricted' ? 1 : 4;
    if (n > limit && !isBasic(info) && !info?.anyNumber) errors.push(`${name}: ${String(n)} copias; el máximo es ${String(limit)}.`);
    if (d.format !== 'casual' && info && !['legal', 'restricted'].includes(info.legalities[d.format] ?? '')) errors.push(`${name} no es legal en ${d.format}.`);
  }
  const unplayable = Object.keys(both).filter((name) => { const def = reg.get(name); return !def || def.status === 'unsupported' || !!def.token || !!def.frontFace; });
  return { errors, unplayable };
}

/** Mana value histogram of non-land cards, 0..7+ . */
export function manaCurve(d: Deck): number[] {
  const curve = Array<number>(8).fill(0);
  for (const [name, n] of Object.entries(d.main)) {
    const c = d.info[name];
    if (!c || /\bLand\b/.test(c.typeLine)) continue;
    curve[Math.min(7, Math.floor(c.cmc))] = (curve[Math.min(7, Math.floor(c.cmc))] ?? 0) + n;
  }
  return curve;
}

/** Colored mana symbols across the main deck, e.g. { W: 12, R: 20 }. Hybrid counts for each color. */
export function colorSymbols(d: Deck): Record<string, number> {
  const out: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const [name, n] of Object.entries(d.main)) {
    for (const sym of d.info[name]?.manaCost.match(/\{[^}]+\}/g) ?? []) {
      for (const c of ['W', 'U', 'B', 'R', 'G']) if (sym.includes(c)) out[c] = (out[c] ?? 0) + n;
    }
  }
  return out;
}

export const TYPE_GROUPS = ['Criaturas', 'Planeswalkers', 'Instantáneos', 'Conjuros', 'Encantamientos', 'Artefactos', 'Tierras', 'Otras'] as const;

/** Type group used to lay out the deck list (a creature land counts as a land). */
export function typeGroup(typeLine: string): (typeof TYPE_GROUPS)[number] {
  const front = typeLine.split('//')[0] ?? '';
  if (/\bLand\b/.test(front)) return 'Tierras';
  if (/\bCreature\b/.test(front)) return 'Criaturas';
  if (/\bPlaneswalker\b/.test(front)) return 'Planeswalkers';
  if (/\bInstant\b/.test(front)) return 'Instantáneos';
  if (/\bSorcery\b/.test(front)) return 'Conjuros';
  if (/\bEnchantment\b/.test(front)) return 'Encantamientos';
  if (/\bArtifact\b/.test(front)) return 'Artefactos';
  return 'Otras';
}
