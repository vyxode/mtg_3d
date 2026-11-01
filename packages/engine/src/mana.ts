import type { ManaCost, ManaPool, ManaType } from './types';

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

export const emptyPool = (): ManaPool => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

/** Parses "{2}{U}{U}" into a ManaCost. Only generic and single-symbol costs for now. */
export function parseManaCost(text: string): ManaCost {
  const cost: ManaCost = { generic: 0 };
  const symbols = text.match(/\{[^}]+\}/g) ?? [];
  if (symbols.join('') !== text) throw new Error(`Malformed mana cost: ${text}`);
  for (const raw of symbols) {
    const s = raw.slice(1, -1);
    if (/^\d+$/.test(s)) cost.generic += Number(s);
    else if (s === 'W' || s === 'U' || s === 'B' || s === 'R' || s === 'G' || s === 'C') cost[s] = (cost[s] ?? 0) + 1;
    // shortcut: hybrid, Phyrexian, X and snow symbols are rejected; add them when a card that uses them is implemented.
    else throw new Error(`Unsupported mana symbol {${s}} in ${text}`);
  }
  return cost;
}

export const manaValue = (cost: ManaCost | null): number =>
  cost === null ? 0 : cost.generic + COLORS.reduce((n, c) => n + (cost[c] ?? 0), 0) + (cost.C ?? 0);

/**
 * Pays `cost` from `pool`. Returns the remaining pool, or null if the pool cannot pay.
 * shortcut: generic is paid with colorless first, then W,U,B,R,G in that order; the player cannot
 * choose which leftover mana stays. Upgrade when restricted mana or leftover color starts to matter.
 */
export function payFromPool(pool: ManaPool, cost: ManaCost): ManaPool | null {
  const left = { ...pool };
  for (const t of [...COLORS, 'C'] as ManaType[]) {
    const need = cost[t] ?? 0;
    if (left[t] < need) return null;
    left[t] -= need;
  }
  let generic = cost.generic;
  for (const t of ['C', ...COLORS] as ManaType[]) {
    const use = Math.min(left[t], generic);
    left[t] -= use;
    generic -= use;
  }
  return generic === 0 ? left : null;
}
