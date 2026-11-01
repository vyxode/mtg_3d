import { solvePayment, type CardRegistry, type ManaCost, type ObjectId, type PlayerView } from '@mtg3d/engine';

/**
 * Picks which of the player's mana sources to tap for `cost`, counting mana already floating.
 * A convenience only: the server re-checks the payment. Returns null when the sources cannot pay.
 */
export function autopay(view: PlayerView, reg: CardRegistry, sources: ObjectId[], cost: ManaCost | null): ObjectId[] | null {
  // Lands before creatures, so mana creatures stay free to attack or block.
  const ordered = [...sources].sort((a, b) => Number(view.objects[a]?.power !== 0) - Number(view.objects[b]?.power !== 0));
  const plan = solvePayment(
    view.players[view.viewer].manaPool,
    ordered.map((id) => ({ id, produce: reg.get(view.objects[id]?.card ?? '')?.manaAbilities?.[0]?.produce ?? [] })),
    cost ?? { generic: 0 },
  );
  return plan ? plan.map((x) => x.id) : null;
}
