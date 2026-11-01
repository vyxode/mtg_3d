import type { CardRegistry, ManaCost, ManaType, ObjectId, PlayerView } from '@mtg3d/engine';

const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

/**
 * Picks which of the player's available mana sources to tap for `cost`, counting mana already floating.
 * A convenience only: the server re-checks the payment. Returns null when the sources cannot pay.
 */
export function autopay(view: PlayerView, reg: CardRegistry, sources: ObjectId[], cost: ManaCost | null): ObjectId[] | null {
  const need: Record<ManaType, number> = { W: cost?.W ?? 0, U: cost?.U ?? 0, B: cost?.B ?? 0, R: cost?.R ?? 0, G: cost?.G ?? 0, C: cost?.C ?? 0 };
  let generic = cost?.generic ?? 0;
  const pool = { ...view.players[view.viewer].manaPool };
  for (const c of COLORS) { const use = Math.min(pool[c], need[c]); pool[c] -= use; need[c] -= use; }
  for (const c of COLORS) { const use = Math.min(pool[c], generic); pool[c] -= use; generic -= use; }

  const produces = (id: ObjectId): ManaType | undefined => {
    const card = view.objects[id]?.card;
    return card ? reg.get(card)?.manaAbilities?.[0]?.produce : undefined;
  };
  // Prefer lands over creatures, so mana creatures stay free to attack or block.
  const left = [...sources].sort((a, b) => Number(view.objects[a]?.power !== 0) - Number(view.objects[b]?.power !== 0));
  const chosen: ObjectId[] = [];
  for (const c of COLORS) {
    while (need[c] > 0) {
      const i = left.findIndex((id) => produces(id) === c);
      if (i < 0) return null;
      chosen.push(...left.splice(i, 1));
      need[c] -= 1;
    }
  }
  if (left.length < generic) return null;
  chosen.push(...left.slice(0, generic));
  return chosen;
}
