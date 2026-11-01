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

export type TargetSpec = 'anyTarget' | 'creature' | 'spell' | 'player'
  /** "target creature you control" (from the point of view of the spell's or ability's controller). */
  | 'creatureYouControl'
  /** "target creature with power 2 or less". */
  | 'creaturePowerAtMost2'
  /** "target land you control". */
  | 'landYouControl'
  | 'creatureOpponentControls'
  | 'nonbasicLandOpponentControls'
  /** "target card from a graveyard" (any graveyard). */
  | 'cardInGraveyard';

/** Counter kinds other than +1/+1 (kept in `GameObject.counters`) and loyalty. */
export type CounterKind = 'quest';

/** Abilities an effect can grant until end of turn (layer 6). */
export type GrantedAbility = Keyword | 'cantBeBlocked';

export type Effect =
  | { kind: 'damage'; amount: number; target: number }
  | { kind: 'draw'; amount: number }
  | { kind: 'drawEach'; amount: number }
  | { kind: 'targetDraws'; target: number; amount: number }
  /** 701.17: `'you'` mills the controller of the spell or ability. */
  | { kind: 'mill'; target: number | 'you'; amount: number }
  | { kind: 'gainLife'; amount: number }
  | { kind: 'counter'; target: number }
  | { kind: 'destroy'; target: number }
  | { kind: 'createToken'; token: string; amount: number }
  /** +1/+1 counters (or `counter` counters) on a target, or on the ability's source ('self'). */
  | { kind: 'addCounters'; target: number | 'self'; amount: number; counter?: CounterKind }
  | { kind: 'pump'; power: number; toughness: number; target: number; duration: 'endOfTurn' }
  /** 701.10d: it gets +X/+0 until end of turn, where X is its power as the effect begins. */
  | { kind: 'doublePower'; target: number }
  /** 701.10e: put as many +1/+1 counters on it as it already has. */
  | { kind: 'doubleCounters'; target: 'self' }
  /** One target gains an ability until end of turn (layer 6). */
  | { kind: 'grant'; ability: GrantedAbility; target: number }
  /** Permanents you control with any of these subtypes gain an ability until end of turn; the set is locked in as it resolves (611.2c). */
  | { kind: 'grantAll'; ability: GrantedAbility; subtypes: string[] }
  /**
   * 701.23: search your library for a basic land card, put it onto the battlefield, then shuffle. Finding nothing is
   * allowed (701.23b). `untapIfLands`: "then if you control N or more lands, untap that land".
   */
  /** `who: 'targetController'`: the player who controlled target `target` as the ability began resolving. */
  | { kind: 'searchBasicLand'; tapped: boolean; untapIfLands?: number; who?: 'targetController'; target?: number }
  /** 701.14: the creature this Aura enchants fights the target (each deals damage equal to its power to the other). */
  | { kind: 'enchantedFights'; target: number }
  /** Exile a target card; with `track`, remember it was exiled with the source ("cards exiled with …"). */
  | { kind: 'exileTarget'; target: number; track?: true }
  /**
   * Earthbend N: target land you control becomes a 0/0 creature with haste that's still a land. Put N +1/+1 counters
   * on it. When it dies or is exiled, return it to the battlefield tapped.
   */
  | { kind: 'earthbend'; target: number; amount: number }
  /** 603.12: "When you do, …": triggers the source's reflexive ability `trigger` (an entry of its `triggers`). */
  | { kind: 'reflexive'; trigger: number }
  /** Delayed triggers only: return the watched card to the battlefield tapped, from wherever it went. */
  | { kind: 'returnSubjectTapped' }
  /** Delayed triggers only (warp): exile the watched permanent; its owner may cast it from exile on a later turn. */
  | { kind: 'exileSubjectWarp' };

export interface ManaAbility {
  cost: 'tap';
  /** One mana of any of these types (a dual land lists two). */
  produce: ManaType[];
}

/** Keyword abilities implemented by the engine (rule 702). */
export type Keyword =
  | 'Flying' | 'Reach' | 'Vigilance' | 'Haste' | 'Defender' | 'Menace'
  | 'First strike' | 'Double strike' | 'Deathtouch' | 'Trample' | 'Lifelink' | 'Indestructible';

/** "When [this] enters" / "When [this] dies" (603.6a, 603.6c with look-back). */
export interface TriggerDef {
  /** landYouControlEnters = landfall: "whenever a land you control enters". */
  on: 'selfEntersBattlefield' | 'selfDies' | 'controllerGainsLife' | 'landYouControlEnters'
    /** "Whenever a creature you control or a creature spell you control becomes the target of a spell or ability an opponent controls". */
    | 'creatureYouControlTargetedByOpponent'
    /** Only put on the stack by a `reflexive` effect of the same card (603.12). */
    | 'reflexive';
  /** "Up to one target" (115.? 601.2c): its targets may be left unchosen. */
  upToOne?: true;
  /** Intervening "if" (603.4): checked when it triggers and again as it resolves. */
  condition?: { selfCounters: CounterKind; atLeast: number };
  targets: TargetSpec[];
  effects: Effect[];
}

/** "[Cost]: [Effect]" (602). */
export interface ActivatedDef {
  /** Shown to players, e.g. "{T}: 1 damage to any target". */
  text: string;
  /** loyalty: +N adds, -N removes loyalty counters; a loyalty ability is sorcery-speed and once per turn (606.3). */
  cost: { mana?: ManaCost; tap?: boolean; loyalty?: number; sacrifice?: true; exile?: true };
  /** "Activate only as a sorcery" (602.5d). */
  sorcerySpeed?: true;
  targets: TargetSpec[];
  effects: Effect[];
}

/** Static abilities that change characteristics (604, 613). */
export type StaticDef =
  | { kind: 'anthem'; affects: 'creaturesYouControl' | 'otherCreaturesYouControl'; power: number; toughness: number }
  /** "You may play an additional land on each of your turns" (305.2). */
  | { kind: 'extraLandDrop' }
  /** "You may play lands from your graveyard." */
  | { kind: 'playLandsFromGraveyard' }
  /** An Aura's "enchanted creature gets +X/+Y" (and "can't be blocked by more than one creature"). */
  | { kind: 'enchantedGets'; power: number; toughness: number; maxBlockers?: number }
  /** "As long as there are N or more card types among cards exiled with this, it gets +X/+Y and has …". */
  | { kind: 'ifExiledCardTypes'; atLeast: number; power: number; toughness: number; keywords: Keyword[] };

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
  /** Starting loyalty of a planeswalker (306.5b). */
  loyalty?: number;
  /** Instants and sorceries: targets and effects of the spell ability. */
  spell?: { targets: TargetSpec[]; effects: Effect[] };
  manaAbilities?: ManaAbility[];
  keywords?: Keyword[];
  triggers?: TriggerDef[];
  activated?: ActivatedDef[];
  statics?: StaticDef[];
  /** Replacement effects on entering the battlefield (614.1c, 614.12). */
  etb?: { tapped: true } | { tappedUnlessPayLife: number } | { tappedUnlessYouControlBasicLand: true };
  /** Auras (303.4): what it can enchant; casting it targets that. */
  enchant?: TargetSpec;
  /** Warp (702.185): may be cast from your hand for this cost; then exiled at the next end step and castable from exile later. */
  warp?: ManaCost;
  /** "This spell can't be countered" (101.6). */
  cantBeCountered?: true;
  /** "This creature enters with N +1/+1 counters on it" (614.1c). */
  entersWithCounters?: number;
  /** Affinity for a subtype (702.41): costs {1} less for each permanent with it you control. */
  affinityFor?: string;
  /** Token definitions (111): they cease to exist outside the battlefield. */
  token?: true;
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
  /** 704.5h: dealt damage by a source with deathtouch since SBAs were last checked. */
  deathtouchDamage: boolean;
  /** +1/+1 counters. */
  counters: number;
  /** Other counters by kind (quest…). */
  kindCounters?: Partial<Record<CounterKind, number>>;
  /** Warp (702.185a): exiled by its warp ability on this turn; its owner may cast it from exile on any later turn. */
  warpExiledTurn?: number;
  /** The object an Aura is attached to (303.4). */
  attachedTo?: ObjectId;
  /** Exiled by this object's ability ("cards exiled with …", 607). */
  exiledBy?: ObjectId;
  loyalty: number;
  /** Turn number of its last loyalty activation (606.3). */
  loyaltyTurn: number;
  timestamp: number;
}

export type Target = { kind: 'player'; player: PlayerId } | { kind: 'object'; id: ObjectId };

export type StackEntry =
  /** A spell: `id` is the card object in the stack zone. */
  | { kind: 'spell'; id: ObjectId; card: string; controller: PlayerId; targets: Target[]; warp?: true }
  /** A triggered ability: not an object; `source` may already have left its zone (look-back). */
  | { kind: 'ability'; id: string; card: string; source: ObjectId; ability: { kind: 'trigger' | 'activated'; index: number }; controller: PlayerId; targets: Target[]; delayed?: { effects: Effect[]; subject: ObjectId } };

/** A triggered ability waiting to be put on the stack the next time a player would receive priority (603.3). */
export interface PendingTrigger {
  id: string;
  card: string;
  source: ObjectId;
  trigger: number;
  controller: PlayerId;
  /** Set once its controller has chosen the order of their simultaneous triggers. */
  ordered: boolean;
  /** Delayed triggers carry their own effects instead of an index into the card's `triggers`. */
  delayed?: { effects: Effect[]; subject: ObjectId };
}

/** 'permanent': lasts as long as the affected object exists (a new object after a zone change is not affected, 400.7). */
export type Duration = 'endOfTurn' | 'permanent';

export type ContinuousEffect =
  | { layer: '7c'; affected: ObjectId; power: number; toughness: number; duration: Duration; timestamp: number }
  | { layer: '7b'; affected: ObjectId; power: number; toughness: number; duration: Duration; timestamp: number }
  | { layer: '6'; affected: ObjectId; grant: GrantedAbility; duration: Duration; timestamp: number }
  | { layer: '4'; affected: ObjectId; addType: CardType; duration: Duration; timestamp: number };

/** A delayed triggered ability (603.7), created by a resolving spell or ability. */
export interface DelayedTrigger {
  id: string;
  card: string;
  controller: PlayerId;
  /** The object it refers to ("it", "this creature"). */
  subject: ObjectId;
  on: 'subjectDiesOrIsExiled' | 'nextEndStep';
  /** For nextEndStep: the turn it was created on, and whether that was already during the end step (then it waits a turn). */
  createdTurn: number;
  createdDuringEnd: boolean;
  effects: Effect[];
}

/** A spell or ability partway through resolving: it can stop for a choice (e.g. which card to find) and continue. */
export interface Resolution {
  entry: StackEntry;
  effects: Effect[];
  targets: Target[];
  legal: boolean[];
  /** Controller of each object target as resolution began (last known information for "that land's controller"). */
  targetControllers: (PlayerId | null)[];
  /** Index of the next effect to perform. */
  next: number;
}

export interface CombatState {
  /** `planeswalker` set when attacking a planeswalker instead of the player (508.1b). */
  attackers: { id: ObjectId; defending: PlayerId; planeswalker?: ObjectId | undefined }[];
  blocks: { blocker: ObjectId; attacker: ObjectId }[];
  /** Damage division chosen by the attacking player; the key 'player' is damage trampled over to the defender. */
  assignments: Record<ObjectId, Record<string, number>>;
  /** 510.4: 'first' while only first and double strikers deal damage, then 'regular'. */
  damageStep: 'first' | 'regular' | null;
  /** Creatures that had first or double strike when the first combat damage step began. */
  firstStrikers: ObjectId[];
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
  pendingTriggers: PendingTrigger[];
  resolving: Resolution | null;
  delayedTriggers: DelayedTrigger[];
  /** Who receives priority once pending triggers are on the stack (placing them may need decisions first). */
  priorityTo: PlayerId | null;
  pending: PendingDecision | null;
  result: GameResult | null;
}

// ---------- Decisions ----------

export type LegalAction =
  | { kind: 'playLand'; card: ObjectId }
  /** `cost`: what the engine will charge, after reductions such as affinity. */
  | { kind: 'cast'; card: ObjectId; targetOptions: Target[][]; cost: ManaCost; warp?: true }
  | { kind: 'activateMana'; source: ObjectId }
  | { kind: 'activate'; source: ObjectId; ability: number; targetOptions: Target[][] };

type DecisionBase = { id: number; player: PlayerId };

export type PendingDecision =
  | (DecisionBase & { kind: 'chooseStartingPlayer' })
  | (DecisionBase & { kind: 'mulligan'; mulligans: number })
  | (DecisionBase & { kind: 'bottomCards'; count: number })
  | (DecisionBase & { kind: 'priority'; legal: LegalAction[] })
  | (DecisionBase & { kind: 'declareAttackers'; candidates: ObjectId[]; planeswalkers: ObjectId[] })
  | (DecisionBase & { kind: 'declareBlockers'; candidates: { blocker: ObjectId; attackers: ObjectId[] }[] })
  | (DecisionBase & { kind: 'assignCombatDamage'; attacker: ObjectId; blockers: ObjectId[]; amount: number; trample: boolean; lethal: Record<ObjectId, number> })
  | (DecisionBase & { kind: 'discard'; count: number })
  /** 603.3b: order your simultaneous triggers; `order` in the response is the order they will resolve. */
  | (DecisionBase & { kind: 'orderTriggers'; triggers: { id: string; card: string }[] })
  /** 603.3d: choose targets as the trigger is put on the stack. */
  | (DecisionBase & { kind: 'chooseTargets'; trigger: string; card: string; targetOptions: Target[][]; optional?: true })
  /** 704.5j: choose the one legendary permanent with this name to keep. */
  | (DecisionBase & { kind: 'legendRule'; name: string; candidates: ObjectId[] })
  /**
   * 701.23: choose a card found in your library by name, or none. Only the searching player sees the options;
   * library object ids are never sent, so a search reveals nothing about the library's order.
   */
  | (DecisionBase & { kind: 'searchLibrary'; source: string; cards: string[] });

export type Response =
  | { kind: 'chooseStartingPlayer'; first: PlayerId }
  | { kind: 'keep' }
  | { kind: 'mulligan' }
  | { kind: 'bottomCards'; cards: ObjectId[] }
  | { kind: 'pass' }
  | { kind: 'playLand'; card: ObjectId; payLife?: boolean | undefined }
  | { kind: 'cast'; card: ObjectId; targets: Target[]; payment: ObjectId[]; warp?: boolean | undefined }
  | { kind: 'activateMana'; source: ObjectId; mana?: ManaType | undefined }
  | { kind: 'activate'; source: ObjectId; ability: number; targets: Target[]; payment: ObjectId[] }
  | { kind: 'declareAttackers'; attackers: ObjectId[]; planeswalkerTargets?: Record<ObjectId, ObjectId> | undefined }
  | { kind: 'declareBlockers'; blocks: { blocker: ObjectId; attacker: ObjectId }[] }
  | { kind: 'assignCombatDamage'; assignment: Record<string, number> }
  | { kind: 'discard'; cards: ObjectId[] }
  | { kind: 'orderTriggers'; order: string[] }
  | { kind: 'chooseTargets'; targets: Target[] }
  | { kind: 'legendRule'; keep: ObjectId }
  | { kind: 'searchLibrary'; card: string | null };

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
  | { kind: 'zoneChange'; from: ObjectId; to: ObjectId; card: string; fromZone: ZoneName; toZone: ZoneName; owner: PlayerId; lastController: PlayerId }
  | { kind: 'triggered'; card: string; controller: PlayerId; ability: string }
  | { kind: 'activated'; card: string; controller: PlayerId; ability: string }
  | { kind: 'tokenCreated'; id: ObjectId; card: string; controller: PlayerId }
  | { kind: 'countersAdded'; id: ObjectId; amount: number }
  | { kind: 'searched'; player: PlayerId; found: ObjectId | null }
  /** "Becomes the target" (603.2): emitted as a spell or ability is put on the stack with its targets. */
  | { kind: 'targeted'; by: PlayerId; target: Target }
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
