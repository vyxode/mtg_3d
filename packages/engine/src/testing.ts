/** Test helpers: build a board directly and drive decisions. Not used by the server. */
import { seedRng } from './core/rng';
import { emptyPool } from './mana';
import { step, characteristics } from './game';
import type { CardRegistry, GameEvent, GameState, ObjectId, PendingDecision, PlayerId, Response, Step } from './types';

type Permanent = string | { card: string; tapped?: boolean; sick?: boolean; damage?: number };

interface PlayerSetup {
  life?: number;
  hand?: string[];
  battlefield?: Permanent[];
  library?: string[];
  graveyard?: string[];
}

export interface ScenarioOptions {
  active?: PlayerId;
  step?: Step;
  turn?: number;
  seed?: number;
  p1?: PlayerSetup;
  p2?: PlayerSetup;
}

/** Builds a state where `active` has priority in `step` (main1 by default). */
export function scenario(reg: CardRegistry, o: ScenarioOptions = {}): GameState {
  const active = o.active ?? 'p1';
  const s: GameState = {
    rules: 'CR-2026-06-19', rng: seedRng(o.seed ?? 1), nextId: 1, nextTimestamp: 1, nextDecisionId: 1, startingPlayer: 'p1',
    players: {
      p1: { id: 'p1', life: o.p1?.life ?? 20, manaPool: emptyPool(), drewFromEmptyLibrary: false, lost: false, mulligans: 0 },
      p2: { id: 'p2', life: o.p2?.life ?? 20, manaPool: emptyPool(), drewFromEmptyLibrary: false, lost: false, mulligans: 0 },
    },
    objects: {},
    zones: { library: { p1: [], p2: [] }, hand: { p1: [], p2: [] }, graveyard: { p1: [], p2: [] }, battlefield: [], exile: [] },
    stack: [], turn: { number: o.turn ?? 3, active, step: o.step ?? 'main1', passed: [], landsPlayed: 0 },
    combat: null, effects: [], pendingTriggers: [], priorityTo: null, pending: null, result: null,
  };
  const add = (card: string, owner: PlayerId, zone: 'library' | 'hand' | 'graveyard' | 'battlefield', extra: Partial<{ tapped: boolean; sick: boolean; damage: number }> = {}) => {
    if (!reg.has(card)) throw new Error(`Unknown card in scenario: ${card}`);
    const id = `o${String(s.nextId++)}`;
    s.objects[id] = { id, card, owner, controller: owner, zone, tapped: extra.tapped ?? false, damage: extra.damage ?? 0, summoningSick: extra.sick ?? false, deathtouchDamage: false, counters: 0, timestamp: s.nextTimestamp++ };
    if (zone === 'battlefield') s.zones.battlefield.push(id);
    else s.zones[zone][owner].push(id);
  };
  for (const p of ['p1', 'p2'] as const) {
    const setup = o[p] ?? {};
    for (const c of setup.library ?? []) add(c, p, 'library');
    for (const c of setup.hand ?? []) add(c, p, 'hand');
    for (const c of setup.graveyard ?? []) add(c, p, 'graveyard');
    for (const c of setup.battlefield ?? []) {
      if (typeof c === 'string') add(c, p, 'battlefield');
      else add(c.card, p, 'battlefield', { ...(c.tapped !== undefined && { tapped: c.tapped }), ...(c.sick !== undefined && { sick: c.sick }), ...(c.damage !== undefined && { damage: c.damage }) });
    }
  }
  s.pending = { id: s.nextDecisionId++, kind: 'priority', player: active, legal: [] };
  return s;
}

export interface Driver {
  state: GameState;
  events: GameEvent[];
  /** Answers the pending decision as whoever holds it; throws if the engine rejects it. */
  do(response: Response): Driver;
  /** Like do(), but expects a rejection and returns its message. */
  reject(response: Response): string;
  pending<K extends PendingDecision['kind']>(kind?: K): Extract<PendingDecision, { kind: K }>;
  /** Ids of a player's objects in a zone with the given card name. */
  ids(player: PlayerId, zone: 'hand' | 'battlefield' | 'graveyard' | 'library', card: string): ObjectId[];
  id(player: PlayerId, zone: 'hand' | 'battlefield' | 'graveyard' | 'library', card: string): ObjectId;
  power(id: ObjectId): number;
  toughness(id: ObjectId): number;
}

export function drive(reg: CardRegistry, initial: GameState): Driver {
  const d: Driver = {
    state: initial,
    events: [],
    do(response) {
      const pend = d.state.pending;
      if (!pend) throw new Error('No pending decision');
      const r = step(d.state, { player: pend.player, decisionId: pend.id, response }, reg);
      if (!r.ok) throw new Error(`Rejected ${response.kind}: ${r.error}`);
      d.state = r.state;
      d.events.push(...r.events);
      return d;
    },
    reject(response) {
      const pend = d.state.pending;
      if (!pend) throw new Error('No pending decision');
      const r = step(d.state, { player: pend.player, decisionId: pend.id, response }, reg);
      if (r.ok) throw new Error(`Expected ${response.kind} to be rejected`);
      return r.error;
    },
    pending<K extends PendingDecision['kind']>(kind?: K) {
      const p = d.state.pending;
      if (!p) throw new Error('No pending decision');
      if (kind && p.kind !== kind) throw new Error(`Expected pending ${kind}, got ${p.kind}`);
      return p as Extract<PendingDecision, { kind: K }>;
    },
    ids(player, zone, card) {
      const list = zone === 'battlefield' ? d.state.zones.battlefield.filter((id) => d.state.objects[id]?.controller === player) : d.state.zones[zone][player];
      return list.filter((id) => d.state.objects[id]?.card === card);
    },
    id(player, zone, card) {
      const id = d.ids(player, zone, card)[0];
      if (id === undefined) throw new Error(`No ${card} in ${player}'s ${zone}`);
      return id;
    },
    power: (id) => characteristics(d.state, reg, id).power,
    toughness: (id) => characteristics(d.state, reg, id).toughness,
  };
  return d;
}
