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

/**
 * Chooses which sources to tap, and for which color, so that pool + produced mana pays `cost`.
 * Sources are tried in the given order (put lands first); depth-first search with backtracking,
 * so it finds a payment whenever one exists. Returns the sources actually needed, or null.
 */
export function solvePayment(pool: ManaPool, sources: { id: string; produce: ManaType[] }[], cost: ManaCost): { id: string; mana: ManaType }[] | null {
  const need: Record<ManaType, number> = { W: cost.W ?? 0, U: cost.U ?? 0, B: cost.B ?? 0, R: cost.R ?? 0, G: cost.G ?? 0, C: cost.C ?? 0 };
  let generic = cost.generic;
  const left = { ...pool };
  for (const t of [...COLORS, 'C'] as ManaType[]) { const u = Math.min(left[t], need[t]); left[t] -= u; need[t] -= u; }
  generic = Math.max(0, generic - Object.values(left).reduce((a, b) => a + b, 0));

  const chosen: { id: string; mana: ManaType }[] = [];
  const done = () => generic === 0 && Object.values(need).every((n) => n === 0);
  const dfs = (i: number): boolean => {
    if (done()) return true;
    const src = sources[i];
    if (!src) return false;
    for (const m of src.produce) { // use it for a colored symbol it can pay
      if (need[m] === 0) continue;
      need[m]--; chosen.push({ id: src.id, mana: m });
      if (dfs(i + 1)) return true;
      need[m]++; chosen.pop();
    }
    if (generic > 0) { // or for generic
      generic--; chosen.push({ id: src.id, mana: src.produce[0] as ManaType });
      if (dfs(i + 1)) return true;
      generic++; chosen.pop();
    }
    return dfs(i + 1); // or leave it untapped
  };
  return dfs(0) ? chosen : null;
}
