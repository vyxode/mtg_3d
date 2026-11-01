import { CARDS } from '@mtg3d/cards';
import type { ObjectId, PlayerId, PlayerView, VisibleObject } from '@mtg3d/engine';

/** Card size in world units (63 × 88 mm at 1 unit = 31.5 mm). */
export const CARD_W = 2;
export const CARD_H = 2.8;

export type Highlight = 'playable' | 'attacking' | 'blocking' | null;

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
  badges: string[];
  highlight: Highlight;
}

const LIB_X = 13;
const GRAVE_X = 13;
const EXILE_X = -13;
const ROW_WIDTH = 22;

/** Side of the table: the viewer sits at +z. */
const side = (p: PlayerId, viewer: PlayerId) => (p === viewer ? 1 : -1);

export const libraryPos = (p: PlayerId, viewer: PlayerId) => ({ x: LIB_X, y: 0, z: side(p, viewer) * 6.6 });

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
  if (o.types.includes('Creature') && o.summoningSick && !CARDS.get(o.card)?.keywords?.includes('Haste')) out.push('mareada');
  return out;
}

// An animated land (earthbend) is a creature: it fights in the front row.
const isLand = (o: VisibleObject) => o.types.includes('Land') && !o.types.includes('Creature');

/** Everything visible on the table from the viewer's seat; `playable` are the cards the viewer can use now. */
export function layoutTable(view: PlayerView, playable: ReadonlySet<ObjectId> = new Set()): Placement[] {
  const me = view.viewer;
  const out: Placement[] = [];
  const attackers = new Set(view.combat?.attackers.map((a) => a.id));
  const blocking = new Map(view.combat?.blocks.map((b) => [b.blocker, b.attacker]));

  for (const p of ['p1', 'p2'] as const) {
    const s = side(p, me);
    const yaw = s === 1 ? 0 : Math.PI;
    const mine = view.zones.battlefield.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.controller === p);
    const rows = [mine.filter((o) => !isLand(o)), mine.filter(isLand)];
    rows.forEach((row, r) => {
      const xs = spread(row.length);
      row.forEach((o, i) => {
        out.push({
          key: o.id, card: o.card, owner: o.owner, x: xs[i] ?? 0, y: 0.01 + i * 0.002, z: s * (r === 0 ? 3 : 6.6),
          yaw: yaw - (o.tapped ? Math.PI / 2 : 0), tilt: 0, badges: badgesOf(o),
          highlight: attackers.has(o.id) ? 'attacking' : blocking.has(o.id) ? 'blocking' : playable.has(o.id) ? 'playable' : null,
        });
      });
    });

    const grave = view.zones.graveyard[p];
    const top = view.objects[grave[grave.length - 1] ?? ''];
    if (top) out.push({ key: top.id, card: top.card, owner: p, x: GRAVE_X, y: 0.01, z: s * 3, yaw, tilt: 0, badges: [`cementerio ${String(grave.length)}`], highlight: null });

    const exiled = view.zones.exile.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.owner === p);
    const lastExiled = exiled[exiled.length - 1];
    if (lastExiled) out.push({ key: lastExiled.id, card: lastExiled.card, owner: p, x: EXILE_X, y: 0.01, z: s * 3, yaw, tilt: 0, badges: [`exilio ${String(exiled.length)}`], highlight: null });

    const lib = view.players[p].librarySize;
    if (lib > 0) out.push({ key: `library-${p}`, card: null, owner: p, ...libraryPos(p, me), y: lib * 0.01, yaw, tilt: 0, badges: [`biblioteca ${String(lib)}`], highlight: null });
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

  // The viewer's hand stands up in front of the camera; the opponent's is face down at the far edge.
  const hand = view.zones.hand.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o);
  spread(hand.length, 18, 0.15).forEach((x, i) => {
    const o = hand[i] as VisibleObject;
    out.push({ key: o.id, card: o.card, owner: me, x, y: 1.6 + i * 0.01, z: 9.6, yaw: 0, tilt: 1.0, badges: [], highlight: playable.has(o.id) ? 'playable' : null });
  });
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';
  spread(view.players[opp].handSize, 14, 0.1).forEach((x, i) => {
    out.push({ key: `hand-${opp}-${String(i)}`, card: null, owner: opp, x, y: 0.01 + i * 0.002, z: -9.8, yaw: Math.PI, tilt: 0, badges: [], highlight: null });
  });

  // The stack, top entry nearest the viewer, to the right of the battlefield.
  view.stack.forEach((e, i) => {
    out.push({
      key: e.id, card: e.card, owner: e.controller, x: 9 - i * 0.35, y: 0.3 + i * 0.05, z: -1.4 + i * 0.5, yaw: 0, tilt: 0,
      badges: e.kind === 'ability' ? ['habilidad'] : [], highlight: null,
    });
  });
  return out;
}
