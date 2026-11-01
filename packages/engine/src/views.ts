import { characteristics } from './game';
import type {
  CardRegistry, CardType, CombatState, CounterKind, GameEvent, GameResult, GameState, ManaPool, ObjectId, PendingDecision,
  PlayerId, StackEntry, Step, ZoneName,
} from './types';

/** An object the viewer is allowed to see, with its derived characteristics. */
export interface VisibleObject {
  id: ObjectId;
  card: string;
  owner: PlayerId;
  controller: PlayerId;
  zone: ZoneName;
  tapped: boolean;
  damage: number;
  summoningSick: boolean;
  power: number;
  toughness: number;
  loyalty: number;
  counters: number;
  /** Current card types (an earthbent land is also a creature). */
  types: CardType[];
  otherCounters: Partial<Record<CounterKind, number>>;
  /** Exiled with warp: its owner may cast it from exile after this turn. */
  warpExiledTurn?: number;
  /** The permanent an Aura enchants. */
  attachedTo?: ObjectId;
}

export interface PlayerView {
  viewer: PlayerId;
  turn: { number: number; active: PlayerId; step: Step };
  players: Record<PlayerId, { life: number; manaPool: ManaPool; librarySize: number; handSize: number; lost: boolean; mulligans: number }>;
  objects: Record<ObjectId, VisibleObject>;
  zones: {
    hand: ObjectId[]; // viewer's own hand only
    battlefield: ObjectId[];
    graveyard: Record<PlayerId, ObjectId[]>;
    exile: ObjectId[];
  };
  stack: StackEntry[];
  combat: CombatState | null;
  /** Full decision for its owner; only its kind and player for the other. */
  pending: PendingDecision | { kind: PendingDecision['kind']; player: PlayerId; id: number } | null;
  result: GameResult | null;
}

const PUBLIC_ZONES: ReadonlySet<ZoneName> = new Set(['battlefield', 'stack', 'graveyard', 'exile']);

const canSee = (zone: ZoneName, owner: PlayerId, viewer: PlayerId): boolean =>
  PUBLIC_ZONES.has(zone) || (zone === 'hand' && owner === viewer);

/**
 * The only way game state leaves the server. Libraries, the opponent's hand and the RNG are never included.
 * shortcut: hidden cards are sent as counts, not opaque ids; give them ids when the 3D table needs to animate them.
 */
export function viewFor(s: GameState, reg: CardRegistry, viewer: PlayerId): PlayerView {
  const objects: Record<ObjectId, VisibleObject> = {};
  for (const o of Object.values(s.objects)) {
    if (!canSee(o.zone, o.owner, viewer)) continue;
    const c = characteristics(s, reg, o.id);
    objects[o.id] = {
      id: o.id, card: o.card, owner: o.owner, controller: o.controller, zone: o.zone,
      tapped: o.tapped, damage: o.damage, summoningSick: o.summoningSick, power: c.power, toughness: c.toughness, loyalty: o.loyalty, counters: o.counters,
      types: c.types, otherCounters: { ...o.kindCounters }, ...(o.warpExiledTurn !== undefined && { warpExiledTurn: o.warpExiledTurn }),
      ...(o.attachedTo !== undefined && { attachedTo: o.attachedTo }),
    };
  }
  const player = (p: PlayerId) => {
    const pl = s.players[p];
    return { life: pl.life, manaPool: { ...pl.manaPool }, librarySize: s.zones.library[p].length, handSize: s.zones.hand[p].length, lost: pl.lost, mulligans: pl.mulligans };
  };
  const pending = s.pending === null ? null
    : s.pending.player === viewer ? s.pending
    : { kind: s.pending.kind, player: s.pending.player, id: s.pending.id };
  return {
    viewer,
    turn: { number: s.turn.number, active: s.turn.active, step: s.turn.step },
    players: { p1: player('p1'), p2: player('p2') },
    objects,
    zones: {
      hand: [...s.zones.hand[viewer]],
      battlefield: [...s.zones.battlefield],
      graveyard: { p1: [...s.zones.graveyard.p1], p2: [...s.zones.graveyard.p2] },
      exile: [...s.zones.exile],
    },
    stack: s.stack.map((e) => ({ ...e, targets: [...e.targets] })),
    combat: s.combat ? JSON.parse(JSON.stringify(s.combat)) as CombatState : null,
    pending,
    result: s.result,
  };
}

/** Events as the viewer may see them: anything about a hidden card loses its identity. */
export function eventsFor(events: GameEvent[], viewer: PlayerId): GameEvent[] {
  const out: GameEvent[] = [];
  for (const e of events) {
    if (e.kind === 'drew' && e.player !== viewer) { out.push({ kind: 'drew', player: e.player, card: '' }); continue; }
    if (e.kind === 'zoneChange') {
      const seeFrom = canSee(e.fromZone, e.owner, viewer);
      const seeTo = canSee(e.toZone, e.owner, viewer);
      if (seeFrom && seeTo) out.push(e);
      else if (seeTo) out.push({ ...e, from: '' });
      else if (seeFrom) out.push({ ...e, to: '' });
      else out.push({ ...e, from: '', to: '', card: '' });
      continue;
    }
    out.push(e);
  }
  return out;
}
