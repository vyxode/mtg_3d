import type { RngState } from './core/rng';

// ---------- Basics ----------

export type PlayerId = 'p1' | 'p2';
export type ObjectId = string;
export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export type ManaType = Color | 'C';
export type ManaPool = Record<ManaType, number>;

export type Step =
  | 'untap' | 'upkeep' | 'draw' | 'main1'
  | 'beginCombat' | 'declareAttackers' | 'declareBlockers' | 'combatDamage' | 'endCombat'
  | 'main2' | 'end' | 'cleanup';

export type ZoneName = 'library' | 'hand' | 'graveyard' | 'battlefield' | 'stack' | 'exile';

// ---------- Card definitions (data, not code: the DSL) ----------

export type CardType = 'Land' | 'Creature' | 'Instant' | 'Sorcery' | 'Artifact' | 'Enchantment' | 'Planeswalker';

/** Parsed mana cost, e.g. {1}{U}{U} => { generic: 1, U: 2 }. */
export interface ManaCost {
  generic: number;
  W?: number; U?: number; B?: number; R?: number; G?: number; C?: number;
}

export type TargetSpec = 'anyTarget' | 'creature' | 'spell';

export type Effect =
  | { kind: 'damage'; amount: number; target: number }
  | { kind: 'draw'; amount: number }
  | { kind: 'counter'; target: number }
  | { kind: 'pump'; power: number; toughness: number; target: number; duration: 'endOfTurn' };

export interface ManaAbility {
  cost: 'tap';
  produce: ManaType;
}

/** 'tested' = has its own scenario test; only tested and implemented cards are playable in strict mode. */
export type ImplStatus = 'tested' | 'implemented' | 'unsupported';

export interface CardDef {
  name: string;
  status: ImplStatus;
  manaCost: ManaCost | null;
  types: CardType[];
  supertypes?: ('Basic' | 'Legendary')[];
  subtypes?: string[];
  power?: number;
  toughness?: number;
  /** Instants and sorceries: targets and effects of the spell ability. */
  spell?: { targets: TargetSpec[]; effects: Effect[] };
  manaAbilities?: ManaAbility[];
}

export type CardRegistry = ReadonlyMap<string, CardDef>;

// ---------- Game state ----------

export interface PlayerState {
  id: PlayerId;
  life: number;
  manaPool: ManaPool;
  drewFromEmptyLibrary: boolean;
  lost: boolean;
  mulligans: number;
}

export interface GameObject {
  id: ObjectId;
  /** Card name: the key into the card registry (Oracle names are unique). */
  card: string;
  owner: PlayerId;
  controller: PlayerId;
  zone: ZoneName;
  tapped: boolean;
  damage: number;
  /** Rule 302.6: true until its controller has controlled it continuously since their most recent turn began. */
  summoningSick: boolean;
  timestamp: number;
}

export type Target = { kind: 'player'; player: PlayerId } | { kind: 'object'; id: ObjectId };

export interface StackEntry {
  /** The spell object (a card in the stack zone). */
  id: ObjectId;
  controller: PlayerId;
  targets: Target[];
}

export interface ContinuousEffect {
  layer: '7c';
  affected: ObjectId;
  power: number;
  toughness: number;
  duration: 'endOfTurn';
  timestamp: number;
}

export interface CombatState {
  attackers: { id: ObjectId; defending: PlayerId }[];
  blocks: { blocker: ObjectId; attacker: ObjectId }[];
  /** Damage division chosen by the attacking player for attackers blocked by several creatures. */
  assignments: Record<ObjectId, Record<ObjectId, number>>;
}

export interface TurnState {
  number: number;
  active: PlayerId;
  step: Step;
  /** Players who passed priority in succession since the last action. */
  passed: PlayerId[];
  landsPlayed: number;
}

export interface Zones {
  library: Record<PlayerId, ObjectId[]>; // index 0 = top
  hand: Record<PlayerId, ObjectId[]>;
  graveyard: Record<PlayerId, ObjectId[]>; // last = top
  battlefield: ObjectId[];
  exile: ObjectId[];
}

export type GameResult = { winner: PlayerId | null; reason: string };

export interface GameState {
  rules: 'CR-2026-06-19';
  rng: RngState;
  nextId: number;
  nextTimestamp: number;
  nextDecisionId: number;
  startingPlayer: PlayerId | null;
  players: Record<PlayerId, PlayerState>;
  objects: Record<ObjectId, GameObject>;
  zones: Zones;
  stack: StackEntry[]; // last = top
  turn: TurnState;
  combat: CombatState | null;
  effects: ContinuousEffect[];
  pending: PendingDecision | null;
  result: GameResult | null;
}

// ---------- Decisions ----------

export type LegalAction =
  | { kind: 'playLand'; card: ObjectId }
  | { kind: 'cast'; card: ObjectId; targetOptions: Target[][] }
  | { kind: 'activateMana'; source: ObjectId };

type DecisionBase = { id: number; player: PlayerId };

export type PendingDecision =
  | (DecisionBase & { kind: 'chooseStartingPlayer' })
  | (DecisionBase & { kind: 'mulligan'; mulligans: number })
  | (DecisionBase & { kind: 'bottomCards'; count: number })
  | (DecisionBase & { kind: 'priority'; legal: LegalAction[] })
  | (DecisionBase & { kind: 'declareAttackers'; candidates: ObjectId[] })
  | (DecisionBase & { kind: 'declareBlockers'; candidates: { blocker: ObjectId; attackers: ObjectId[] }[] })
  | (DecisionBase & { kind: 'assignCombatDamage'; attacker: ObjectId; blockers: ObjectId[]; amount: number })
  | (DecisionBase & { kind: 'discard'; count: number });

export type Response =
  | { kind: 'chooseStartingPlayer'; first: PlayerId }
  | { kind: 'keep' }
  | { kind: 'mulligan' }
  | { kind: 'bottomCards'; cards: ObjectId[] }
  | { kind: 'pass' }
  | { kind: 'playLand'; card: ObjectId }
  | { kind: 'cast'; card: ObjectId; targets: Target[]; payment: ObjectId[] }
  | { kind: 'activateMana'; source: ObjectId }
  | { kind: 'declareAttackers'; attackers: ObjectId[] }
  | { kind: 'declareBlockers'; blocks: { blocker: ObjectId; attacker: ObjectId }[] }
  | { kind: 'assignCombatDamage'; assignment: Record<ObjectId, number> }
  | { kind: 'discard'; cards: ObjectId[] };

/** What a client sends: its answer to the decision with id `decisionId`, or a concession at any time. */
export type PlayerInput =
  | { player: PlayerId; decisionId: number; response: Response }
  | { player: PlayerId; concede: true };

// ---------- Events (log, triggers later, animations) ----------

export type GameEvent =
  | { kind: 'turnStarted'; turn: number; active: PlayerId }
  | { kind: 'stepStarted'; step: Step }
  | { kind: 'shuffled'; player: PlayerId }
  | { kind: 'drew'; player: PlayerId; card: ObjectId }
  | { kind: 'zoneChange'; from: ObjectId; to: ObjectId; card: string; fromZone: ZoneName; toZone: ZoneName; owner: PlayerId }
  | { kind: 'tapped'; id: ObjectId }
  | { kind: 'untapped'; id: ObjectId }
  | { kind: 'manaAdded'; player: PlayerId; mana: ManaType }
  | { kind: 'cast'; player: PlayerId; spell: ObjectId; targets: Target[] }
  | { kind: 'resolved'; spell: ObjectId }
  | { kind: 'fizzled'; spell: ObjectId }
  | { kind: 'countered'; spell: ObjectId }
  | { kind: 'damage'; source: ObjectId; target: Target; amount: number; combat: boolean }
  | { kind: 'lifeChanged'; player: PlayerId; from: number; to: number }
  | { kind: 'attackersDeclared'; attackers: ObjectId[] }
  | { kind: 'blockersDeclared'; blocks: { blocker: ObjectId; attacker: ObjectId }[] }
  | { kind: 'mulligan'; player: PlayerId; count: number }
  | { kind: 'playerLost'; player: PlayerId; reason: string }
  | { kind: 'gameOver'; result: GameResult };

export type StepResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };
