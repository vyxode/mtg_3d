import { seedRng, nextInt, shuffle } from './core/rng';
import { emptyPool, payFromPool } from './mana';
import type {
  CardDef, CardRegistry, ContinuousEffect, GameEvent, GameObject, GameState, LegalAction, ObjectId,
  PendingDecision, PlayerId, PlayerInput, Response, Step, StepResult, Target, TargetSpec, ZoneName,
} from './types';

const MAX_HAND_SIZE = 7;
const OPENING_HAND = 7;

class RuleError extends Error {}

interface Ctx {
  s: GameState;
  reg: CardRegistry;
  events: GameEvent[];
}

const other = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');
const fail = (msg: string): never => { throw new RuleError(msg); };

// ---------- Characteristics ----------

export interface Characteristics {
  name: string;
  types: CardDef['types'];
  power: number;
  toughness: number;
}

export function defOf(reg: CardRegistry, card: string): CardDef {
  return reg.get(card) ?? fail(`Unknown card: ${card}`);
}

/** Derived characteristics. shortcut: only layer 7c (P/T modifications) exists; layers 1–7b come with D2. */
export function characteristics(s: GameState, reg: CardRegistry, id: ObjectId): Characteristics {
  const obj = s.objects[id] ?? fail(`Unknown object ${id}`);
  const def = defOf(reg, obj.card);
  let power = def.power ?? 0;
  let toughness = def.toughness ?? 0;
  for (const e of s.effects) {
    if (e.affected === id) { power += e.power; toughness += e.toughness; }
  }
  return { name: def.name, types: def.types, power, toughness };
}

const isType = (c: { types: readonly string[] }, t: string): boolean => c.types.includes(t);
const onBattlefield = (s: GameState, id: ObjectId): boolean => s.objects[id]?.zone === 'battlefield';
const isCreatureOnBattlefield = (ctx: Ctx, id: ObjectId): boolean =>
  onBattlefield(ctx.s, id) && isType(characteristics(ctx.s, ctx.reg, id), 'Creature');

// ---------- Objects and zones ----------

function newObject(ctx: Ctx, card: string, owner: PlayerId, zone: ZoneName): ObjectId {
  const id = `o${String(ctx.s.nextId++)}`;
  ctx.s.objects[id] = {
    id, card, owner, controller: owner, zone,
    tapped: false, damage: 0, summoningSick: true, timestamp: ctx.s.nextTimestamp++,
  };
  return id;
}

function zoneList(s: GameState, zone: ZoneName, owner: PlayerId): ObjectId[] | null {
  switch (zone) {
    case 'library': case 'hand': case 'graveyard': return s.zones[zone][owner];
    case 'battlefield': case 'exile': return s.zones[zone];
    case 'stack': return null; // the stack is s.stack (entries), handled by callers
  }
}

/**
 * Moves an object to another zone. Per rule 400.7 it becomes a new object with a new id.
 * shortcut: no last-known-information snapshot is kept yet; D2 adds it together with triggers.
 */
function moveObject(ctx: Ctx, id: ObjectId, to: ZoneName, opts: { bottom?: boolean; controller?: PlayerId } = {}): ObjectId {
  const s = ctx.s;
  const obj = s.objects[id] ?? fail(`Unknown object ${id}`);
  const fromList = zoneList(s, obj.zone, obj.owner);
  if (fromList) fromList.splice(fromList.indexOf(id), 1);
  else s.stack = s.stack.filter((e) => e.id !== id);
  Reflect.deleteProperty(s.objects, id);

  const newId = newObject(ctx, obj.card, obj.owner, to);
  const moved = s.objects[newId] as GameObject;
  moved.controller = opts.controller ?? obj.owner;
  const toList = zoneList(s, to, obj.owner);
  if (toList) {
    if (to === 'library' && !opts.bottom) toList.unshift(newId);
    else toList.push(newId);
  }
  ctx.events.push({ kind: 'zoneChange', from: id, to: newId, card: obj.card, fromZone: obj.zone, toZone: to, owner: obj.owner });
  return newId;
}

function draw(ctx: Ctx, p: PlayerId): void {
  const top = ctx.s.zones.library[p][0];
  if (top === undefined) { ctx.s.players[p].drewFromEmptyLibrary = true; return; }
  const id = moveObject(ctx, top, 'hand');
  ctx.events.push({ kind: 'drew', player: p, card: id });
}

function shuffleLibrary(ctx: Ctx, p: PlayerId): void {
  const [lib, rng] = shuffle(ctx.s.zones.library[p], ctx.s.rng);
  ctx.s.zones.library[p] = lib;
  ctx.s.rng = rng;
  ctx.events.push({ kind: 'shuffled', player: p });
}

function setLife(ctx: Ctx, p: PlayerId, life: number): void {
  const from = ctx.s.players[p].life;
  ctx.s.players[p].life = life;
  ctx.events.push({ kind: 'lifeChanged', player: p, from, to: life });
}

function tap(ctx: Ctx, id: ObjectId): void {
  (ctx.s.objects[id] as GameObject).tapped = true;
  ctx.events.push({ kind: 'tapped', id });
}

function setPending(ctx: Ctx, d: DistributiveOmit<PendingDecision, 'id'>): void {
  ctx.s.pending = { ...d, id: ctx.s.nextDecisionId++ };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------- State-based actions (rule 704) ----------

/** Performs SBAs until none apply (704.3). Returns true if any was performed. */
function runSBA(ctx: Ctx): boolean {
  const s = ctx.s;
  let any = false;
  for (;;) {
    const losers = (['p1', 'p2'] as const).filter((p) => {
      const pl = s.players[p];
      return !pl.lost && (pl.life <= 0 || pl.drewFromEmptyLibrary); // 704.5a, 704.5b
    });
    const dying = s.zones.battlefield.filter((id) => {
      const c = characteristics(s, ctx.reg, id);
      if (!isType(c, 'Creature')) return false;
      return c.toughness <= 0 || (s.objects[id] as GameObject).damage >= c.toughness; // 704.5f, 704.5g
    });
    if (losers.length === 0 && dying.length === 0) break;
    any = true;
    for (const p of losers) {
      s.players[p].lost = true;
      ctx.events.push({ kind: 'playerLost', player: p, reason: s.players[p].life <= 0 ? 'life' : 'emptyLibrary' });
    }
    for (const id of dying) moveObject(ctx, id, 'graveyard');
  }
  checkGameOver(ctx);
  return any;
}

function checkGameOver(ctx: Ctx): void {
  const s = ctx.s;
  if (s.result) return;
  const lost = (['p1', 'p2'] as const).filter((p) => s.players[p].lost);
  if (lost.length === 0) return;
  s.result = lost.length === 2 ? { winner: null, reason: 'draw' } : { winner: other(lost[0] as PlayerId), reason: 'opponentLost' };
  s.pending = null;
  ctx.events.push({ kind: 'gameOver', result: s.result });
}

// ---------- Priority ----------

function givePriority(ctx: Ctx, p: PlayerId): void {
  runSBA(ctx); // 117.5: SBAs (and later triggers) before any player receives priority
  if (ctx.s.result) return;
  setPending(ctx, { kind: 'priority', player: p, legal: legalActions(ctx, p) });
}

const isMain = (step: Step): boolean => step === 'main1' || step === 'main2';

function canCastSorcerySpeed(ctx: Ctx, p: PlayerId): boolean {
  const t = ctx.s.turn;
  return t.active === p && isMain(t.step) && ctx.s.stack.length === 0;
}

function targetOptions(ctx: Ctx, spec: TargetSpec): Target[] {
  const s = ctx.s;
  const creatures = s.zones.battlefield.filter((id) => isCreatureOnBattlefield(ctx, id)).map((id): Target => ({ kind: 'object', id }));
  switch (spec) {
    case 'anyTarget':
      return [...(['p1', 'p2'] as const).filter((p) => !s.players[p].lost).map((p): Target => ({ kind: 'player', player: p })), ...creatures];
    case 'creature': return creatures;
    case 'spell': return s.stack.map((e): Target => ({ kind: 'object', id: e.id }));
  }
}

function isLegalTarget(ctx: Ctx, spec: TargetSpec, t: Target, self: ObjectId | null): boolean {
  if (t.kind === 'object' && t.id === self) return false; // 115.5: a spell can't target itself
  return targetOptions(ctx, spec).some((o) => sameTarget(o, t));
}

const sameTarget = (a: Target, b: Target): boolean =>
  a.kind === 'player' ? b.kind === 'player' && a.player === b.player : b.kind === 'object' && a.id === b.id;

function canActivateMana(ctx: Ctx, p: PlayerId, id: ObjectId): boolean {
  const obj = ctx.s.objects[id];
  if (obj?.zone !== 'battlefield' || obj.controller !== p || obj.tapped) return false;
  const def = defOf(ctx.reg, obj.card);
  if (!def.manaAbilities?.length) return false;
  // 302.6: a creature's {T} abilities need it to have been controlled since the start of the turn.
  return !(isType(def, 'Creature') && obj.summoningSick);
}

function legalActions(ctx: Ctx, p: PlayerId): LegalAction[] {
  const s = ctx.s;
  const out: LegalAction[] = [];
  const sorcerySpeed = canCastSorcerySpeed(ctx, p);
  for (const id of s.zones.hand[p]) {
    const def = defOf(ctx.reg, (s.objects[id] as GameObject).card);
    if (isType(def, 'Land')) {
      if (sorcerySpeed && s.turn.landsPlayed < 1) out.push({ kind: 'playLand', card: id });
      continue;
    }
    if (!isType(def, 'Instant') && !sorcerySpeed) continue;
    const opts = (def.spell?.targets ?? []).map((spec) => targetOptions(ctx, spec));
    if (opts.every((o) => o.length > 0)) out.push({ kind: 'cast', card: id, targetOptions: opts });
  }
  for (const id of s.zones.battlefield) if (canActivateMana(ctx, p, id)) out.push({ kind: 'activateMana', source: id });
  return out;
}

function activateMana(ctx: Ctx, p: PlayerId, id: ObjectId): void {
  if (!canActivateMana(ctx, p, id)) fail(`Cannot activate a mana ability of ${id}`);
  const ability = defOf(ctx.reg, (ctx.s.objects[id] as GameObject).card).manaAbilities?.[0] ?? fail('No mana ability');
  tap(ctx, id);
  ctx.s.players[p].manaPool[ability.produce] += 1;
  ctx.events.push({ kind: 'manaAdded', player: p, mana: ability.produce });
}

function onPass(ctx: Ctx, p: PlayerId): void {
  const t = ctx.s.turn;
  t.passed.push(p);
  if (!t.passed.includes(other(p))) { givePriority(ctx, other(p)); return; }
  // 117.4: all players passed in succession
  if (ctx.s.stack.length > 0) {
    resolveTop(ctx);
    t.passed = [];
    givePriority(ctx, t.active); // 117.3b
  } else {
    endStep(ctx);
  }
}

function afterAction(ctx: Ctx, p: PlayerId): void {
  ctx.s.turn.passed = [];
  givePriority(ctx, p); // 117.3c: the player who acted receives priority
}

// ---------- Casting (601.2) and resolution (608) ----------

function playLand(ctx: Ctx, p: PlayerId, id: ObjectId): void {
  const obj = ctx.s.objects[id];
  if (obj?.zone !== 'hand' || obj.owner !== p) fail('That card is not in your hand');
  if (!isType(defOf(ctx.reg, (obj as GameObject).card), 'Land')) fail('Only lands can be played');
  if (!canCastSorcerySpeed(ctx, p)) fail('Lands can only be played in your main phase with an empty stack');
  if (ctx.s.turn.landsPlayed >= 1) fail('You already played a land this turn');
  ctx.s.turn.landsPlayed += 1;
  moveObject(ctx, id, 'battlefield', { controller: p });
  afterAction(ctx, p);
}

function cast(ctx: Ctx, p: PlayerId, r: Extract<Response, { kind: 'cast' }>): void {
  const s = ctx.s;
  const obj = s.objects[r.card];
  if (obj?.zone !== 'hand' || obj.owner !== p) fail('That card is not in your hand');
  const def = defOf(ctx.reg, (obj as GameObject).card);
  if (def.status === 'unsupported') fail(`${def.name} is not implemented`);
  if (isType(def, 'Land')) fail('Lands are played, not cast');
  if (!isType(def, 'Instant') && !canCastSorcerySpeed(ctx, p)) fail(`${def.name} can only be cast at sorcery speed`);

  const specs = def.spell?.targets ?? [];
  if (r.targets.length !== specs.length) fail(`Expected ${String(specs.length)} target(s)`);
  specs.forEach((spec, i) => { if (!isLegalTarget(ctx, spec, r.targets[i] as Target, null)) fail(`Illegal target #${String(i + 1)}`); });

  if (new Set(r.payment).size !== r.payment.length) fail('Duplicate mana source');
  for (const src of r.payment) activateMana(ctx, p, src);
  const left = payFromPool(s.players[p].manaPool, def.manaCost ?? { generic: 0 }) ?? fail('Not enough mana');
  s.players[p].manaPool = left;

  const spell = moveObject(ctx, r.card, 'stack', { controller: p });
  s.stack.push({ id: spell, controller: p, targets: r.targets });
  ctx.events.push({ kind: 'cast', player: p, spell, targets: r.targets });
  afterAction(ctx, p);
}

function resolveTop(ctx: Ctx): void {
  const s = ctx.s;
  const entry = s.stack[s.stack.length - 1] ?? fail('Empty stack');
  const obj = s.objects[entry.id] as GameObject;
  const def = defOf(ctx.reg, obj.card);

  if (!def.spell) { // permanent spell
    moveObject(ctx, entry.id, 'battlefield', { controller: entry.controller });
    ctx.events.push({ kind: 'resolved', spell: entry.id });
    return;
  }
  const specs = def.spell.targets;
  const legal = specs.map((spec, i) => isLegalTarget(ctx, spec, entry.targets[i] as Target, entry.id));
  if (specs.length > 0 && legal.every((l) => !l)) { // 608.2b
    ctx.events.push({ kind: 'fizzled', spell: entry.id });
    moveObject(ctx, entry.id, 'graveyard');
    return;
  }
  for (const effect of def.spell.effects) {
    if ('target' in effect && !legal[effect.target]) continue; // illegal targets are unaffected
    const t = 'target' in effect ? (entry.targets[effect.target] as Target) : null;
    switch (effect.kind) {
      case 'damage': dealDamage(ctx, entry.id, t as Target, effect.amount, false); break;
      case 'draw': for (let i = 0; i < effect.amount; i++) draw(ctx, entry.controller); break;
      case 'counter': {
        const target = (t as Extract<Target, { kind: 'object' }>).id;
        ctx.events.push({ kind: 'countered', spell: target });
        moveObject(ctx, target, 'graveyard');
        break;
      }
      case 'pump': {
        const e: ContinuousEffect = {
          layer: '7c', affected: (t as Extract<Target, { kind: 'object' }>).id,
          power: effect.power, toughness: effect.toughness, duration: 'endOfTurn', timestamp: s.nextTimestamp++,
        };
        s.effects.push(e);
        break;
      }
    }
  }
  ctx.events.push({ kind: 'resolved', spell: entry.id });
  if (s.objects[entry.id]?.zone === 'stack') moveObject(ctx, entry.id, 'graveyard');
}

function dealDamage(ctx: Ctx, source: ObjectId, target: Target, amount: number, combat: boolean): void {
  if (amount <= 0) return;
  if (target.kind === 'player') setLife(ctx, target.player, ctx.s.players[target.player].life - amount);
  else (ctx.s.objects[target.id] as GameObject).damage += amount;
  ctx.events.push({ kind: 'damage', source, target, amount, combat });
}

// ---------- Turn structure ----------

const STEPS: Step[] = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];

function enterStep(ctx: Ctx, step: Step): void {
  const s = ctx.s;
  s.turn.step = step;
  s.turn.passed = [];
  ctx.events.push({ kind: 'stepStarted', step });
  const active = s.turn.active;
  switch (step) {
    case 'untap':
      for (const id of s.zones.battlefield) {
        const o = s.objects[id] as GameObject;
        if (o.controller !== active) continue;
        o.summoningSick = false;
        if (o.tapped) { o.tapped = false; ctx.events.push({ kind: 'untapped', id }); }
      }
      enterStep(ctx, 'upkeep'); // 502.4: no priority in the untap step
      return;
    case 'draw':
      if (!(s.turn.number === 1 && active === s.startingPlayer)) draw(ctx, active); // 103.8a
      givePriority(ctx, active);
      return;
    case 'declareAttackers': {
      s.combat = { attackers: [], blocks: [], assignments: {} };
      const candidates = s.zones.battlefield.filter((id) => {
        const o = s.objects[id] as GameObject;
        return o.controller === active && !o.tapped && !o.summoningSick && isCreatureOnBattlefield(ctx, id);
      });
      if (candidates.length === 0) { ctx.events.push({ kind: 'attackersDeclared', attackers: [] }); givePriority(ctx, active); }
      else setPending(ctx, { kind: 'declareAttackers', player: active, candidates });
      return;
    }
    case 'declareBlockers': {
      const combat = s.combat ?? fail('No combat');
      const attackers = combat.attackers.filter((a) => onBattlefield(s, a.id)).map((a) => a.id);
      const defender = other(active);
      const candidates = s.zones.battlefield
        .filter((id) => (s.objects[id] as GameObject).controller === defender && !(s.objects[id] as GameObject).tapped && isCreatureOnBattlefield(ctx, id))
        .map((blocker) => ({ blocker, attackers }));
      if (candidates.length === 0 || attackers.length === 0) { ctx.events.push({ kind: 'blockersDeclared', blocks: [] }); givePriority(ctx, active); }
      else setPending(ctx, { kind: 'declareBlockers', player: defender, candidates });
      return;
    }
    case 'combatDamage':
      continueCombatDamage(ctx);
      return;
    case 'cleanup': {
      const hand = s.zones.hand[active];
      if (hand.length > MAX_HAND_SIZE) setPending(ctx, { kind: 'discard', player: active, count: hand.length - MAX_HAND_SIZE });
      else cleanupRest(ctx);
      return;
    }
    default:
      givePriority(ctx, active);
  }
}

/** 514.2 and 514.3a: remove damage and end "until end of turn" effects; SBAs here grant priority and another cleanup. */
function cleanupRest(ctx: Ctx): void {
  const s = ctx.s;
  for (const id of s.zones.battlefield) (s.objects[id] as GameObject).damage = 0;
  s.effects = []; // shortcut: every effect today lasts until end of turn; filter by duration when others exist.
  if (runSBA(ctx)) { givePriority(ctx, s.turn.active); return; }
  if (!s.result) nextTurn(ctx);
}

function endStep(ctx: Ctx): void {
  const s = ctx.s;
  for (const p of ['p1', 'p2'] as const) s.players[p].manaPool = emptyPool(); // 500.4
  const step = s.turn.step;
  if (step === 'cleanup') { enterStep(ctx, 'cleanup'); return; } // 514.3a
  let next = STEPS[STEPS.indexOf(step) + 1] as Step;
  if (step === 'declareAttackers' && (s.combat?.attackers.length ?? 0) === 0) next = 'endCombat'; // 508.8
  if (step === 'endCombat') s.combat = null; // 511.3
  enterStep(ctx, next);
}

function nextTurn(ctx: Ctx): void {
  const t = ctx.s.turn;
  t.number += 1;
  t.active = other(t.active);
  t.landsPlayed = 0;
  ctx.s.combat = null;
  ctx.events.push({ kind: 'turnStarted', turn: t.number, active: t.active });
  enterStep(ctx, 'untap');
}

// ---------- Combat ----------

function declareAttackers(ctx: Ctx, attackers: ObjectId[]): void {
  const s = ctx.s;
  const pending = s.pending as Extract<PendingDecision, { kind: 'declareAttackers' }>;
  if (new Set(attackers).size !== attackers.length) fail('Duplicate attacker');
  for (const id of attackers) if (!pending.candidates.includes(id)) fail(`${id} cannot attack`);
  const combat = s.combat ?? fail('No combat');
  for (const id of attackers) {
    tap(ctx, id); // shortcut: vigilance arrives with keywords in D2
    combat.attackers.push({ id, defending: other(s.turn.active) });
  }
  ctx.events.push({ kind: 'attackersDeclared', attackers });
  givePriority(ctx, s.turn.active);
}

function declareBlockers(ctx: Ctx, blocks: { blocker: ObjectId; attacker: ObjectId }[]): void {
  const s = ctx.s;
  const pending = s.pending as Extract<PendingDecision, { kind: 'declareBlockers' }>;
  if (new Set(blocks.map((b) => b.blocker)).size !== blocks.length) fail('A creature can block only one attacker');
  for (const b of blocks) {
    const c = pending.candidates.find((x) => x.blocker === b.blocker) ?? fail(`${b.blocker} cannot block`);
    if (!c.attackers.includes(b.attacker)) fail(`${b.blocker} cannot block ${b.attacker}`);
  }
  (s.combat ?? fail('No combat')).blocks = blocks;
  ctx.events.push({ kind: 'blockersDeclared', blocks });
  givePriority(ctx, s.turn.active);
}

const aliveBlockers = (ctx: Ctx, attacker: ObjectId): ObjectId[] =>
  (ctx.s.combat?.blocks ?? []).filter((b) => b.attacker === attacker && onBattlefield(ctx.s, b.blocker)).map((b) => b.blocker);

/** 510.1: asks for each damage division still needed, then deals all combat damage simultaneously. */
function continueCombatDamage(ctx: Ctx): void {
  const s = ctx.s;
  const combat = s.combat ?? fail('No combat');
  for (const a of combat.attackers) {
    if (!onBattlefield(s, a.id) || combat.assignments[a.id]) continue;
    const blockers = aliveBlockers(ctx, a.id);
    const power = characteristics(s, ctx.reg, a.id).power;
    if (blockers.length > 1 && power > 0) {
      setPending(ctx, { kind: 'assignCombatDamage', player: s.turn.active, attacker: a.id, blockers, amount: power });
      return;
    }
  }
  const hits: { source: ObjectId; target: Target; amount: number }[] = [];
  for (const a of combat.attackers) {
    if (!onBattlefield(s, a.id)) continue;
    const power = characteristics(s, ctx.reg, a.id).power;
    const wasBlocked = combat.blocks.some((b) => b.attacker === a.id); // 509.1h: stays blocked even if blockers leave
    const blockers = aliveBlockers(ctx, a.id);
    if (!wasBlocked) hits.push({ source: a.id, target: { kind: 'player', player: a.defending }, amount: power });
    else if (blockers.length === 1) hits.push({ source: a.id, target: { kind: 'object', id: blockers[0] as ObjectId }, amount: power });
    else for (const [id, n] of Object.entries(combat.assignments[a.id] ?? {})) hits.push({ source: a.id, target: { kind: 'object', id }, amount: n });
  }
  for (const b of combat.blocks) {
    if (!onBattlefield(s, b.blocker) || !onBattlefield(s, b.attacker)) continue;
    hits.push({ source: b.blocker, target: { kind: 'object', id: b.attacker }, amount: characteristics(s, ctx.reg, b.blocker).power });
  }
  for (const h of hits) dealDamage(ctx, h.source, h.target, h.amount, true);
  givePriority(ctx, s.turn.active);
}

function assignCombatDamage(ctx: Ctx, assignment: Record<ObjectId, number>): void {
  const pending = ctx.s.pending as Extract<PendingDecision, { kind: 'assignCombatDamage' }>;
  let total = 0;
  for (const [id, n] of Object.entries(assignment)) {
    if (!pending.blockers.includes(id)) fail(`${id} is not blocking that attacker`);
    if (!Number.isInteger(n) || n < 0) fail('Damage amounts must be non-negative integers');
    total += n;
  }
  if (total !== pending.amount) fail(`Assign exactly ${String(pending.amount)} damage`);
  (ctx.s.combat ?? fail('No combat')).assignments[pending.attacker] = assignment;
  continueCombatDamage(ctx);
}

// ---------- Game setup and mulligans (103) ----------

export interface NewGameOptions {
  seed: number;
  decks: Record<PlayerId, string[]>;
  startingLife?: number;
}

export function createGame(opts: NewGameOptions, reg: CardRegistry): StepResult {
  const player = (id: PlayerId) => ({
    id, life: opts.startingLife ?? 20, manaPool: emptyPool(), drewFromEmptyLibrary: false, lost: false, mulligans: 0,
  });
  const s: GameState = {
    rules: 'CR-2026-06-19', rng: seedRng(opts.seed), nextId: 1, nextTimestamp: 1, nextDecisionId: 1, startingPlayer: null,
    players: { p1: player('p1'), p2: player('p2') },
    objects: {},
    zones: { library: { p1: [], p2: [] }, hand: { p1: [], p2: [] }, graveyard: { p1: [], p2: [] }, battlefield: [], exile: [] },
    stack: [], turn: { number: 0, active: 'p1', step: 'untap', passed: [], landsPlayed: 0 },
    combat: null, effects: [], pending: null, result: null,
  };
  const ctx: Ctx = { s, reg, events: [] };
  try {
    for (const p of ['p1', 'p2'] as const) {
      for (const card of opts.decks[p]) s.zones.library[p].push(newObject(ctx, defOf(reg, card).name, p, 'library'));
    }
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
  const [i, rng] = nextInt(s.rng, 2); // 103.1: a random player chooses who goes first
  s.rng = rng;
  setPending(ctx, { kind: 'chooseStartingPlayer', player: i === 0 ? 'p1' : 'p2' });
  return { ok: true, state: s, events: ctx.events };
}

function startMulligans(ctx: Ctx, first: PlayerId): void {
  ctx.s.startingPlayer = first;
  for (const p of [first, other(first)]) {
    shuffleLibrary(ctx, p);
    for (let i = 0; i < OPENING_HAND; i++) draw(ctx, p);
  }
  setPending(ctx, { kind: 'mulligan', player: first, mulligans: 0 });
}

function afterKeep(ctx: Ctx, p: PlayerId): void {
  const n = Math.min(ctx.s.players[p].mulligans, ctx.s.zones.hand[p].length);
  if (n > 0) setPending(ctx, { kind: 'bottomCards', player: p, count: n });
  else nextMulliganPlayer(ctx, p);
}

function nextMulliganPlayer(ctx: Ctx, p: PlayerId): void {
  const s = ctx.s;
  if (p === s.startingPlayer) { setPending(ctx, { kind: 'mulligan', player: other(p), mulligans: s.players[other(p)].mulligans }); return; }
  s.turn = { number: 1, active: s.startingPlayer as PlayerId, step: 'untap', passed: [], landsPlayed: 0 };
  ctx.events.push({ kind: 'turnStarted', turn: 1, active: s.turn.active });
  enterStep(ctx, 'untap');
}

function mulligan(ctx: Ctx, p: PlayerId): void {
  const s = ctx.s;
  for (const id of [...s.zones.hand[p]]) moveObject(ctx, id, 'library');
  shuffleLibrary(ctx, p);
  for (let i = 0; i < OPENING_HAND; i++) draw(ctx, p);
  s.players[p].mulligans += 1;
  ctx.events.push({ kind: 'mulligan', player: p, count: s.players[p].mulligans });
  setPending(ctx, { kind: 'mulligan', player: p, mulligans: s.players[p].mulligans });
}

function chooseCardsFromHand(ctx: Ctx, p: PlayerId, cards: ObjectId[], count: number): void {
  if (cards.length !== count) fail(`Choose exactly ${String(count)} card(s)`);
  if (new Set(cards).size !== cards.length) fail('Duplicate card');
  for (const id of cards) if (!ctx.s.zones.hand[p].includes(id)) fail(`${id} is not in your hand`);
}

// ---------- Entry point ----------

const RESPONSE_KINDS: Record<PendingDecision['kind'], Response['kind'][]> = {
  chooseStartingPlayer: ['chooseStartingPlayer'],
  mulligan: ['keep', 'mulligan'],
  bottomCards: ['bottomCards'],
  priority: ['pass', 'playLand', 'cast', 'activateMana'],
  declareAttackers: ['declareAttackers'],
  declareBlockers: ['declareBlockers'],
  assignCombatDamage: ['assignCombatDamage'],
  discard: ['discard'],
};

/** Applies one player input. Pure from the caller's view: the given state is never modified. */
export function step(state: GameState, input: PlayerInput, reg: CardRegistry): StepResult {
  if (state.result) return { ok: false, error: 'The game is over' };
  // The state is plain JSON by design (it is persisted and sent over the network), so a JSON copy is exact.
  const ctx: Ctx = { s: JSON.parse(JSON.stringify(state)) as GameState, reg, events: [] };
  try {
    if ('concede' in input) { // 104.3a: a player can concede at any time
      ctx.s.players[input.player].lost = true;
      ctx.events.push({ kind: 'playerLost', player: input.player, reason: 'conceded' });
      checkGameOver(ctx);
      return { ok: true, state: ctx.s, events: ctx.events };
    }
    const pending = ctx.s.pending ?? fail('No decision is pending');
    if (input.decisionId !== pending.id) fail('Stale decision');
    if (input.player !== pending.player) fail('It is not your decision');
    const r = input.response;
    if (!RESPONSE_KINDS[pending.kind].includes(r.kind)) fail(`Expected a ${pending.kind} response`);
    apply(ctx, pending, r);
    return { ok: true, state: ctx.s, events: ctx.events };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
}

function apply(ctx: Ctx, pending: PendingDecision, r: Response): void {
  const p = pending.player;
  switch (r.kind) {
    case 'chooseStartingPlayer': startMulligans(ctx, r.first); return;
    case 'keep': afterKeep(ctx, p); return;
    case 'mulligan': mulligan(ctx, p); return;
    case 'bottomCards': {
      const count = (pending as Extract<PendingDecision, { kind: 'bottomCards' }>).count;
      chooseCardsFromHand(ctx, p, r.cards, count);
      for (const id of r.cards) moveObject(ctx, id, 'library', { bottom: true });
      nextMulliganPlayer(ctx, p);
      return;
    }
    case 'pass': onPass(ctx, p); return;
    case 'playLand': playLand(ctx, p, r.card); return;
    case 'cast': cast(ctx, p, r); return;
    case 'activateMana': activateMana(ctx, p, r.source); afterAction(ctx, p); return;
    case 'declareAttackers': declareAttackers(ctx, r.attackers); return;
    case 'declareBlockers': declareBlockers(ctx, r.blocks); return;
    case 'assignCombatDamage': assignCombatDamage(ctx, r.assignment); return;
    case 'discard': {
      const count = (pending as Extract<PendingDecision, { kind: 'discard' }>).count;
      chooseCardsFromHand(ctx, p, r.cards, count);
      for (const id of r.cards) moveObject(ctx, id, 'graveyard');
      cleanupRest(ctx);
      return;
    }
  }
}
