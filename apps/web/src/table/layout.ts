import { CARDS } from '@mtg3d/cards';
import type { ObjectId, PlayerId, PlayerView, VisibleObject } from '@mtg3d/engine';

/** Card size in world units (63 × 88 mm at 1 unit = 31.5 mm). */
export const CARD_W = 2;
export const CARD_H = 2.8;

export type Highlight = 'playable' | 'selected' | 'attacking' | 'blocking' | null;

/** Where one card sits on the table. Pure data: the 3D scene only draws and animates it. */
export interface Placement {
  /** Object id, or a synthetic key for hidden cards (library, opponent's hand). */
  key: string;
  /** Card name, or null when face down. */
  card: string | null;
  owner: PlayerId;
  x: number;
  y: number;
  z: number;
  /** Rotation about the table normal: π for the opponent's cards, −π/2 more when tapped. */
  yaw: number;
  /** Rotation that lifts the card towards the camera (the viewer's hand). */
  tilt: number;
  /** Rotation in the card's own plane: the fan of a hand held in the fingers. */
  roll?: number;
  /** Held in a hand (lifts towards the viewer on hover). */
  inHand?: boolean;
  /** Drawn bigger than a card on the table (a spell being cast is held up for both players to read). */
  scale?: number;
  badges: string[];
  /** +1/+1 counters, shown as glass beads on the card (as players use). */
  beads?: number;
  highlight: Highlight;
}

/** Thickness of one sleeved card in a pile. */
export const STACK_H = 0.018;

const LIB_X = 13;
const GRAVE_X = 13;
const EXILE_X = -13;
const ROW_WIDTH = 22;

/** Side of the table: the viewer sits at +z. */
const side = (p: PlayerId, viewer: PlayerId) => (p === viewer ? 1 : -1);

export const libraryPos = (p: PlayerId, viewer: PlayerId) => ({ x: LIB_X, y: 0, z: side(p, viewer) * 6.6 });

/** Deterministic small jitter in −1..1 for an id, so a pile looks dropped by hand and stays the same between redraws. */
const jitter = (id: string, k: number) => {
  let h = k;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h % 1000) / 1000;
};

/** x positions for lands sorted by name: the same lands fanned in one pile, as players keep them; squeezed when they do not fit. */
export function landPiles(names: readonly string[], width = ROW_WIDTH): number[] {
  const FAN = 0.5, GAP = 0.45;
  const groups: number[] = [];
  names.forEach((n, i) => { if (i > 0 && n === names[i - 1]) groups[groups.length - 1] = (groups[groups.length - 1] ?? 0) + 1; else groups.push(1); });
  const widths = groups.map((k) => CARD_W + (k - 1) * FAN);
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (groups.length - 1);
  const sq = Math.min(1, width / total);
  const out: number[] = [];
  let x = (-total * sq) / 2;
  groups.forEach((k, g) => {
    for (let i = 0; i < k; i++) out.push(x + (CARD_W / 2 + i * FAN) * sq);
    x += ((widths[g] ?? 0) + GAP) * sq;
  });
  return out;
}

/** The decks and graveyard piles under their top cards, as boxes this tall. */
export function piles(view: PlayerView): { key: string; owner: PlayerId; x: number; z: number; h: number }[] {
  return (['p1', 'p2'] as const).flatMap((p) => {
    const s = side(p, view.viewer);
    return [
      { key: `deck-${p}`, owner: p, x: LIB_X, z: s * 6.6, h: Math.max(0, view.players[p].librarySize - 1) * STACK_H },
      { key: `grave-${p}`, owner: p, x: GRAVE_X, z: s * 3, h: Math.max(0, view.zones.graveyard[p].length - 3) * STACK_H },
    ].filter((pile) => pile.h > 0);
  });
}

/** x offsets for n cards centered on 0, overlapping when they do not fit in `width`. */
export function spread(n: number, width = ROW_WIDTH, gap = 0.25): number[] {
  const step = n > 1 ? Math.min(CARD_W + gap, (width - CARD_W) / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
}

function badgesOf(o: VisibleObject): string[] {
  const out: string[] = [];
  if (o.types.includes('Creature')) out.push(`${String(o.power)}/${String(o.toughness)}${o.damage > 0 ? ` −${String(o.damage)}` : ''}`);
  if (o.types.includes('Planeswalker')) out.push(`◆ ${String(o.loyalty)}`);
  if (o.counters > 0) out.push(`+1/+1 ×${String(o.counters)}`);
  if (o.otherCounters.quest) out.push(`misión ×${String(o.otherCounters.quest)}`);
  if (o.otherCounters.lore) out.push(`capítulo ${String(o.otherCounters.lore)}`);
  if (o.otherCounters.finality) out.push('finalidad');
  if (o.types.includes('Creature') && o.summoningSick && !CARDS.get(o.card)?.keywords?.includes('Haste')) out.push('mareada');
  return out;
}

// An animated land (earthbend) is a creature: it fights in the front row.
const isLand = (o: VisibleObject) => o.types.includes('Land') && !o.types.includes('Creature');

/** Everything visible on the table from the viewer's seat; `playable` are the cards the viewer can use now. */
export function layoutTable(view: PlayerView, playable: ReadonlySet<ObjectId> = new Set(), selected: ReadonlySet<ObjectId> = new Set(), pointed: ObjectId | null = null): Placement[] {
  const me = view.viewer;
  const out: Placement[] = [];
  const attackers = new Set(view.combat?.attackers.map((a) => a.id));
  const blocking = new Map(view.combat?.blocks.map((b) => [b.blocker, b.attacker]));

  for (const p of ['p1', 'p2'] as const) {
    const s = side(p, me);
    const yaw = s === 1 ? 0 : Math.PI;
    const mine = view.zones.battlefield.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.controller === p);
    const rows = [mine.filter((o) => !isLand(o) && o.attachedTo === undefined), mine.filter((o) => isLand(o) && o.attachedTo === undefined)];
    for (const o of mine.filter((x) => x.attachedTo !== undefined)) { // placed under their host below
      out.push({ key: o.id, card: o.card, owner: o.owner, x: 0, y: 0.01, z: s * 3, yaw, tilt: 0, badges: badgesOf(o), highlight: playable.has(o.id) ? 'playable' : null });
    }
    rows[1]?.sort((a, b) => a.card.localeCompare(b.card));
    rows.forEach((row, r) => {
      const xs = r === 0 ? spread(row.length) : landPiles(row.map((o) => o.card));
      row.forEach((o, i) => {
        out.push({
          key: o.id, card: o.card, owner: o.owner, x: xs[i] ?? 0, y: 0.01 + i * 0.002, z: s * (r === 0 ? 3 : 6.6),
          yaw: yaw - (o.tapped ? Math.PI / 2 : 0), tilt: 0, badges: badgesOf(o), beads: Math.min(o.counters, 10),
          highlight: attackers.has(o.id) ? 'attacking' : blocking.has(o.id) ? 'blocking' : selected.has(o.id) ? 'selected' : playable.has(o.id) ? 'playable' : null,
        });
      });
    });

    // The graveyard: the last cards lie a little askew on top of the pile.
    const grave = view.zones.graveyard[p];
    grave.slice(-3).forEach((id, i, top) => {
      const o = view.objects[id];
      const n = grave.length - top.length + i;
      if (o) out.push({
        key: o.id, card: o.card, owner: p, x: GRAVE_X + jitter(id, 1) * 0.15, y: 0.01 + n * STACK_H, z: s * 3 + jitter(id, 2) * 0.15, yaw: yaw + jitter(id, 3) * 0.12, tilt: 0,
        badges: i === top.length - 1 ? [`cementerio ${String(grave.length)}`] : [], highlight: null,
      });
    });

    const exiled = view.zones.exile.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.owner === p);
    const lastExiled = exiled[exiled.length - 1];
    if (lastExiled) out.push({ key: lastExiled.id, card: lastExiled.card, owner: p, x: EXILE_X, y: 0.01, z: s * 3, yaw, tilt: 0, badges: [`exilio ${String(exiled.length)}`], highlight: null });

    const lib = view.players[p].librarySize;
    if (lib > 0) out.push({ key: `library-${p}`, card: null, owner: p, ...libraryPos(p, me), y: 0.01 + (lib - 1) * STACK_H, yaw, tilt: 0, badges: [`biblioteca ${String(lib)}`], highlight: null });
  }

  // Attackers step towards the middle; each blocker moves in front of the attacker it blocks.
  const byKey = new Map(out.map((pl) => [pl.key, pl]));
  for (const id of attackers) { const pl = byKey.get(id); if (pl) pl.z -= Math.sign(pl.z) * 1.6; }
  const perAttacker = new Map<ObjectId, number>();
  for (const [blocker, attacker] of blocking) {
    const b = byKey.get(blocker);
    const a = byKey.get(attacker);
    if (!b || !a) continue;
    const k = perAttacker.get(attacker) ?? 0;
    perAttacker.set(attacker, k + 1);
    b.x = a.x + k * 0.6;
    b.z = a.z - Math.sign(a.z) * (CARD_H + 0.3);
    b.y = 0.05 + k * 0.01;
  }
  // An Aura tucks under the permanent it enchants, peeking out behind it.
  for (const id of view.zones.battlefield) {
    const host = view.objects[id]?.attachedTo;
    const aura = byKey.get(id);
    const under = host === undefined ? undefined : byKey.get(host);
    if (!aura || !under) continue;
    Object.assign(aura, { x: under.x + 0.35, z: under.z - Math.sign(under.z || 1) * 0.6, y: under.y - 0.006 });
  }

  // Both hands are held up, fanned like real cards: the viewer sees their own faces and the backs of the opponent's.
  const fan = (n: number, width: number) => {
    const step = Math.min(1.45, width / Math.max(1, n));
    return Array.from({ length: n }, (_, i) => { const d = i - (n - 1) / 2; return { d, x: d * step }; });
  };
  const hand = view.zones.hand.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o);
  const at = hand.findIndex((o) => o.id === pointed);
  fan(hand.length, 15).forEach(({ d, x }, i) => {
    const o = hand[i] as VisibleObject;
    const room = at < 0 || i === at ? 0 : Math.sign(i - at) * 0.7; // the cards beside the one you point at make room for it
    out.push({
      key: o.id, card: o.card, owner: me, x: x + room, y: 1.7 - d * d * 0.018 + i * 0.012, z: 12.3 + d * d * 0.025, yaw: 0, tilt: 1.2, roll: -d * 0.06,
      inHand: true, badges: [], highlight: playable.has(o.id) ? 'playable' : null,
    });
  });
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';
  fan(view.players[opp].handSize, 11).forEach(({ d, x }, i) => {
    out.push({ key: `hand-${opp}-${String(i)}`, card: null, owner: opp, x: -x, y: 1.7 - d * d * 0.015 + i * 0.012, z: -10.6, yaw: Math.PI, tilt: 1.05, roll: d * 0.06, badges: [], highlight: null });
  });

  // The stack: spells hang above the middle of the table, the newest highest, tilted towards the viewer.
  view.stack.forEach((e, i) => {
    out.push({
      key: e.id, card: e.card, owner: e.controller, x: i * 1.4 - (view.stack.length - 1) * 0.7, y: 2.6 + i * 0.3, z: 0.4 + i * 0.15, yaw: 0, tilt: 0.95, scale: 1.7,
      badges: e.kind === 'ability' ? ['habilidad'] : [], highlight: null,
    });
  });
  return out;
}
