import { seedRng, nextInt, shuffle } from './core/rng';
import { emptyPool, payFromPool } from './mana';
import type {
  CardDef, CardRegistry, ContinuousEffect, Effect, GameEvent, GameObject, GameState, Keyword, LegalAction, ObjectId,
  PendingDecision, PlayerId, PlayerInput, Response, Step, StepResult, Target, TargetSpec, ZoneName,
} from './types';

const MAX_HAND_SIZE = 7;
const OPENING_HAND = 7;

class RuleError extends Error {}

interface Ctx {
  s: GameState;
  reg: CardRegistry;
  events: GameEvent[];
  /** Index of the first event not yet checked for triggers. */
  scanned: number;
}

const other = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');
const fail = (msg: string): never => { throw new RuleError(msg); };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------- Characteristics ----------

export interface Characteristics {
  name: string;
  types: CardDef['types'];
  power: number;
  toughness: number;
  keywords: Keyword[];
}

export function defOf(reg: CardRegistry, card: string): CardDef {
  return reg.get(card) ?? fail(`Unknown card: ${card}`);
}

/** Derived characteristics. shortcut: only layer 7c (P/T modifications) exists; layers 1–7b come later in D2. */
export function characteristics(s: GameState, reg: CardRegistry, id: ObjectId): Characteristics {
  const obj = s.objects[id] ?? fail(`Unknown object ${id}`);
  const def = defOf(reg, obj.card);
  let power = def.power ?? 0;
  let toughness = def.toughness ?? 0;
  for (const e of s.effects) {
    if (e.affected === id) { power += e.power; toughness += e.toughness; }
  }
  return { name: def.name, types: def.types, power, toughness, keywords: def.keywords ?? [] };
}

const isType = (c: { types: readonly string[] }, t: string): boolean => c.types.includes(t);
const onBattlefield = (s: GameState, id: ObjectId): boolean => s.objects[id]?.zone === 'battlefield';
const isCreatureOnBattlefield = (ctx: Ctx, id: ObjectId): boolean =>
  onBattlefield(ctx.s, id) && isType(characteristics(ctx.s, ctx.reg, id), 'Creature');
const has = (ctx: Ctx, id: ObjectId, kw: Keyword): boolean =>
  ctx.s.objects[id] !== undefined && characteristics(ctx.s, ctx.reg, id).keywords.includes(kw);

// ---------- Objects and zones ----------

function newObject(ctx: Ctx, card: string, owner: PlayerId, zone: ZoneName): ObjectId {
  const id = `o${String(ctx.s.nextId++)}`;
  ctx.s.objects[id] = {
    id, card, owner, controller: owner, zone,
    tapped: false, damage: 0, summoningSick: true, deathtouchDamage: false, timestamp: ctx.s.nextTimestamp++,
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
 * The zoneChange event carries what look-back triggers need (card, last controller).
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
  ctx.events.push({ kind: 'zoneChange', from: id, to: newId, card: obj.card, fromZone: obj.zone, toZone: to, owner: obj.owner, lastController: obj.controller });
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
    const toGraveyard: ObjectId[] = [];
    for (const id of s.zones.battlefield) {
      const c = characteristics(s, ctx.reg, id);
      if (!isType(c, 'Creature')) continue;
      const o = s.objects[id] as GameObject;
      if (c.toughness <= 0) toGraveyard.push(id); // 704.5f (not destruction: indestructible doesn't help)
      else if (!c.keywords.includes('Indestructible') && (o.damage >= c.toughness || o.deathtouchDamage)) toGraveyard.push(id); // 704.5g, 704.5h
    }
    for (const o of Object.values(s.objects)) o.deathtouchDamage = false; // 704.5h looks only since the last check
    if (losers.length === 0 && toGraveyard.length === 0) break;
    any = true;
    for (const p of losers) {
      s.players[p].lost = true;
      ctx.events.push({ kind: 'playerLost', player: p, reason: s.players[p].life <= 0 ? 'life' : 'emptyLibrary' });
    }
    for (const id of toGraveyard) moveObject(ctx, id, 'graveyard');
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

// ---------- Triggered abilities (603) ----------

/** Turns new events into pending triggers. Leaves-the-battlefield triggers look back in time (603.10a). */
function scanTriggers(ctx: Ctx): void {
  for (; ctx.scanned < ctx.events.length; ctx.scanned++) {
    const e = ctx.events[ctx.scanned] as GameEvent;
    if (e.kind !== 'zoneChange') continue;
    const triggers = ctx.reg.get(e.card)?.triggers ?? [];
    triggers.forEach((t, index) => {
      const enters = t.on === 'selfEntersBattlefield' && e.toZone === 'battlefield';
      const dies = t.on === 'selfDies' && e.fromZone === 'battlefield' && e.toZone === 'graveyard';
      if (!enters && !dies) return;
      ctx.s.pendingTriggers.push({
        id: `t${String(ctx.s.nextId++)}`, card: e.card, source: enters ? e.to : e.from, trigger: index,
        controller: enters ? (ctx.s.objects[e.to] as GameObject).controller : e.lastController, ordered: false,
      });
    });
  }
}

/**
 * Puts pending triggers on the stack in APNAP order (603.3b): the active player's first, each player in the
 * order they choose. Returns false when a decision (order or targets) is needed first.
 */
function placeTriggers(ctx: Ctx): boolean {
  const s = ctx.s;
  for (const p of [s.turn.active, other(s.turn.active)]) {
    const mine = s.pendingTriggers.filter((t) => t.controller === p);
    if (mine.length > 1 && mine.some((t) => !t.ordered)) {
      setPending(ctx, { kind: 'orderTriggers', player: p, triggers: mine.map((t) => ({ id: t.id, card: t.card })) });
      return false;
    }
    for (const t of mine) {
      const def = defOf(ctx.reg, t.card).triggers?.[t.trigger] ?? fail('Unknown trigger');
      const options = def.targets.map((spec) => targetOptions(ctx, spec));
      if (options.some((o) => o.length === 0)) { // 603.3d: no legal target, the ability is removed
        s.pendingTriggers = s.pendingTriggers.filter((x) => x.id !== t.id);
        continue;
      }
      if (options.some((o) => o.length > 1)) {
        setPending(ctx, { kind: 'chooseTargets', player: p, trigger: t.id, card: t.card, targetOptions: options });
        return false;
      }
      stackTrigger(ctx, t.id, options.map((o) => o[0] as Target)); // only one legal choice: nothing to decide
    }
  }
  return true;
}

function stackTrigger(ctx: Ctx, triggerId: string, targets: Target[]): void {
  const s = ctx.s;
  const t = s.pendingTriggers.find((x) => x.id === triggerId) ?? fail('Unknown trigger');
  s.pendingTriggers = s.pendingTriggers.filter((x) => x.id !== triggerId);
  s.stack.push({ kind: 'ability', id: t.id, card: t.card, source: t.source, trigger: t.trigger, controller: t.controller, targets });
  ctx.events.push({ kind: 'triggered', card: t.card, controller: t.controller, ability: t.id });
}

// ---------- Priority ----------

/** 117.5: before a player receives priority, SBAs are performed and triggers go on the stack, repeatedly. */
function givePriority(ctx: Ctx, p: PlayerId): void {
  ctx.s.priorityTo = p;
  for (;;) {
    runSBA(ctx);
    if (ctx.s.result) return;
    scanTriggers(ctx);
    if (ctx.s.pendingTriggers.length === 0) break;
    if (!placeTriggers(ctx)) return; // a decision is pending; givePriority resumes after it
  }
  ctx.s.priorityTo = null;
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
    case 'spell': return s.stack.filter((e) => e.kind === 'spell').map((e): Target => ({ kind: 'object', id: e.id }));
  }
}

function isLegalTarget(ctx: Ctx, spec: TargetSpec, t: Target, self: ObjectId | null): boolean {
  if (t.kind === 'object' && t.id === self) return false; // 115.5: a spell can't target itself
  return targetOptions(ctx, spec).some((o) => sameTarget(o, t));
}

const sameTarget = (a: Target, b: Target): boolean =>
  a.kind === 'player' ? b.kind === 'player' && a.player === b.player : b.kind === 'object' && a.id === b.id;

/** 302.6: summoning sickness stops attacking and {T} abilities, unless the creature has haste (702.10). */
const isSick = (ctx: Ctx, id: ObjectId): boolean => (ctx.s.objects[id] as GameObject).summoningSick && !has(ctx, id, 'Haste');

function canActivateMana(ctx: Ctx, p: PlayerId, id: ObjectId): boolean {
  const obj = ctx.s.objects[id];
  if (obj?.zone !== 'battlefield' || obj.controller !== p || obj.tapped) return false;
  const def = defOf(ctx.reg, obj.card);
  if (!def.manaAbilities?.length) return false;
  return !(isType(def, 'Creature') && isSick(ctx, id));
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
  s.stack.push({ kind: 'spell', id: spell, card: def.name, controller: p, targets: r.targets });
  ctx.events.push({ kind: 'cast', player: p, spell, targets: r.targets });
  afterAction(ctx, p);
}

function resolveTop(ctx: Ctx): void {
  const s = ctx.s;
  const entry = s.stack[s.stack.length - 1] ?? fail('Empty stack');
  const def = defOf(ctx.reg, entry.card);

  if (entry.kind === 'ability') {
    s.stack.pop();
    const ability = def.triggers?.[entry.trigger] ?? fail('Unknown trigger');
    const legal = ability.targets.map((spec, i) => isLegalTarget(ctx, spec, entry.targets[i] as Target, null));
    if (ability.targets.length > 0 && legal.every((l) => !l)) { ctx.events.push({ kind: 'fizzled', spell: entry.id }); return; } // 608.2b
    runEffects(ctx, ability.effects, entry.targets, legal, entry.controller, entry.source);
    ctx.events.push({ kind: 'resolved', spell: entry.id });
    return;
  }

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
  runEffects(ctx, def.spell.effects, entry.targets, legal, entry.controller, entry.id);
  ctx.events.push({ kind: 'resolved', spell: entry.id });
  if (s.objects[entry.id]?.zone === 'stack') moveObject(ctx, entry.id, 'graveyard');
}

function runEffects(ctx: Ctx, effects: Effect[], targets: Target[], legal: boolean[], controller: PlayerId, source: ObjectId): void {
  const s = ctx.s;
  for (const effect of effects) {
    if ('target' in effect && !legal[effect.target]) continue; // illegal targets are unaffected
    const t = 'target' in effect ? (targets[effect.target] as Target) : null;
    switch (effect.kind) {
      case 'damage': dealDamage(ctx, source, t as Target, effect.amount, false); break;
      case 'draw': for (let i = 0; i < effect.amount; i++) draw(ctx, controller); break;
      case 'gainLife': setLife(ctx, controller, s.players[controller].life + effect.amount); break;
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
}

/**
 * Deals damage. Deathtouch marks the creature for 704.5h; lifelink gains life at the same time (702.15b).
 * shortcut: a source that already left its zone has no keywords (no last-known-information for characteristics yet).
 */
function dealDamage(ctx: Ctx, source: ObjectId, target: Target, amount: number, combat: boolean): void {
  if (amount <= 0) return;
  const src = ctx.s.objects[source];
  if (target.kind === 'player') setLife(ctx, target.player, ctx.s.players[target.player].life - amount);
  else {
    const o = ctx.s.objects[target.id] as GameObject;
    o.damage += amount;
    if (src && has(ctx, source, 'Deathtouch')) o.deathtouchDamage = true;
  }
  ctx.events.push({ kind: 'damage', source, target, amount, combat });
  if (src && has(ctx, source, 'Lifelink')) setLife(ctx, src.controller, ctx.s.players[src.controller].life + amount);
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
      s.combat = { attackers: [], blocks: [], assignments: {}, damageStep: null, firstStrikers: [] };
      const candidates = s.zones.battlefield.filter((id) => canAttack(ctx, id, active));
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
        .map((blocker) => ({ blocker, attackers: attackers.filter((a) => canBlock(ctx, blocker, a)) }))
        .filter((c) => c.attackers.length > 0);
      if (candidates.length === 0) { ctx.events.push({ kind: 'blockersDeclared', blocks: [] }); givePriority(ctx, active); }
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

/** 514.2 and 514.3a: remove damage and end "until end of turn" effects; SBAs or triggers here grant priority and another cleanup. */
function cleanupRest(ctx: Ctx): void {
  const s = ctx.s;
  for (const id of s.zones.battlefield) (s.objects[id] as GameObject).damage = 0;
  s.effects = []; // shortcut: every effect today lasts until end of turn; filter by duration when others exist.
  const acted = runSBA(ctx);
  scanTriggers(ctx);
  if (acted || s.pendingTriggers.length > 0) { givePriority(ctx, s.turn.active); return; }
  if (!s.result) nextTurn(ctx);
}

function endStep(ctx: Ctx): void {
  const s = ctx.s;
  for (const p of ['p1', 'p2'] as const) s.players[p].manaPool = emptyPool(); // 500.4
  const step = s.turn.step;
  if (step === 'cleanup') { enterStep(ctx, 'cleanup'); return; } // 514.3a
  if (step === 'combatDamage' && s.combat?.damageStep === 'first') { // 510.4: the regular combat damage step follows
    s.combat.damageStep = 'regular';
    s.combat.assignments = {};
    enterStep(ctx, 'combatDamage');
    return;
  }
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

function canAttack(ctx: Ctx, id: ObjectId, active: PlayerId): boolean {
  const o = ctx.s.objects[id] as GameObject;
  return o.controller === active && !o.tapped && isCreatureOnBattlefield(ctx, id) && !isSick(ctx, id) && !has(ctx, id, 'Defender'); // 702.3b
}

/** 702.9b flying: only creatures with flying or reach (702.17b) can block it. */
function canBlock(ctx: Ctx, blocker: ObjectId, attacker: ObjectId): boolean {
  return !has(ctx, attacker, 'Flying') || has(ctx, blocker, 'Flying') || has(ctx, blocker, 'Reach');
}

function declareAttackers(ctx: Ctx, attackers: ObjectId[]): void {
  const s = ctx.s;
  const pending = s.pending as Extract<PendingDecision, { kind: 'declareAttackers' }>;
  if (new Set(attackers).size !== attackers.length) fail('Duplicate attacker');
  for (const id of attackers) if (!pending.candidates.includes(id)) fail(`${id} cannot attack`);
  const combat = s.combat ?? fail('No combat');
  for (const id of attackers) {
    if (!has(ctx, id, 'Vigilance')) tap(ctx, id); // 702.20b
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
  for (const a of new Set(blocks.map((b) => b.attacker))) { // 702.110b menace
    if (has(ctx, a, 'Menace') && blocks.filter((b) => b.attacker === a).length < 2) fail('A creature with menace must be blocked by two or more creatures');
  }
  (s.combat ?? fail('No combat')).blocks = blocks;
  ctx.events.push({ kind: 'blockersDeclared', blocks });
  givePriority(ctx, s.turn.active);
}

const aliveBlockers = (ctx: Ctx, attacker: ObjectId): ObjectId[] =>
  (ctx.s.combat?.blocks ?? []).filter((b) => b.attacker === attacker && onBattlefield(ctx.s, b.blocker)).map((b) => b.blocker);

/**
 * Lethal damage for assignment (702.19c): remaining toughness, or 1 if the source has deathtouch (702.2c).
 * shortcut: damage being assigned by other creatures in the same step is not counted yet.
 */
function lethalFor(ctx: Ctx, blocker: ObjectId, source: ObjectId): number {
  const c = characteristics(ctx.s, ctx.reg, blocker);
  const remaining = Math.max(0, c.toughness - (ctx.s.objects[blocker] as GameObject).damage);
  return has(ctx, source, 'Deathtouch') ? Math.min(1, remaining) : remaining;
}

/** 510.1, 510.4: asks for each damage division still needed, then deals this step's combat damage simultaneously. */
function continueCombatDamage(ctx: Ctx): void {
  const s = ctx.s;
  const combat = s.combat ?? fail('No combat');
  const strikes = (id: ObjectId) => has(ctx, id, 'First strike') || has(ctx, id, 'Double strike');
  if (combat.damageStep === null) {
    const participants = [...combat.attackers.map((a) => a.id), ...combat.blocks.map((b) => b.blocker)].filter((id) => onBattlefield(s, id));
    combat.firstStrikers = participants.filter(strikes);
    combat.damageStep = combat.firstStrikers.length > 0 ? 'first' : 'regular';
  }
  const dealsNow = (id: ObjectId): boolean => combat.damageStep === 'first'
    ? strikes(id)
    : !combat.firstStrikers.includes(id) || has(ctx, id, 'Double strike');

  for (const a of combat.attackers) {
    if (!onBattlefield(s, a.id) || !dealsNow(a.id) || combat.assignments[a.id]) continue;
    const power = characteristics(s, ctx.reg, a.id).power;
    const blockers = aliveBlockers(ctx, a.id);
    if (power <= 0 || blockers.length === 0) continue;
    const trample = has(ctx, a.id, 'Trample');
    const lethal = Object.fromEntries(blockers.map((b) => [b, lethalFor(ctx, b, a.id)]));
    if (blockers.length > 1 || (trample && power > (lethal[blockers[0] as ObjectId] ?? 0))) {
      setPending(ctx, { kind: 'assignCombatDamage', player: s.turn.active, attacker: a.id, blockers, amount: power, trample, lethal });
      return;
    }
  }

  const hits: { source: ObjectId; target: Target; amount: number }[] = [];
  for (const a of combat.attackers) {
    if (!onBattlefield(s, a.id) || !dealsNow(a.id)) continue;
    const power = characteristics(s, ctx.reg, a.id).power;
    const defender: Target = { kind: 'player', player: a.defending };
    const wasBlocked = combat.blocks.some((b) => b.attacker === a.id); // 509.1h: stays blocked even if blockers leave
    const blockers = aliveBlockers(ctx, a.id);
    const assignment = combat.assignments[a.id];
    if (!wasBlocked) hits.push({ source: a.id, target: defender, amount: power });
    else if (blockers.length === 0) { if (has(ctx, a.id, 'Trample')) hits.push({ source: a.id, target: defender, amount: power }); } // 702.19e
    else if (assignment) {
      for (const [key, n] of Object.entries(assignment)) hits.push({ source: a.id, target: key === 'player' ? defender : { kind: 'object', id: key }, amount: n });
    } else hits.push({ source: a.id, target: { kind: 'object', id: blockers[0] as ObjectId }, amount: power });
  }
  for (const b of combat.blocks) {
    if (!onBattlefield(s, b.blocker) || !onBattlefield(s, b.attacker) || !dealsNow(b.blocker)) continue;
    hits.push({ source: b.blocker, target: { kind: 'object', id: b.attacker }, amount: characteristics(s, ctx.reg, b.blocker).power });
  }
  for (const h of hits) dealDamage(ctx, h.source, h.target, h.amount, true);
  givePriority(ctx, s.turn.active);
}

function assignCombatDamage(ctx: Ctx, assignment: Record<string, number>): void {
  const pending = ctx.s.pending as Extract<PendingDecision, { kind: 'assignCombatDamage' }>;
  let total = 0;
  for (const [key, n] of Object.entries(assignment)) {
    if (key === 'player' ? !pending.trample : !pending.blockers.includes(key)) fail(`Cannot assign damage to ${key}`);
    if (!Number.isInteger(n) || n < 0) fail('Damage amounts must be non-negative integers');
    total += n;
  }
  if (total !== pending.amount) fail(`Assign exactly ${String(pending.amount)} damage`);
  if ((assignment.player ?? 0) > 0) { // 702.19b: trample needs lethal damage on every blocker first
    for (const b of pending.blockers) if ((assignment[b] ?? 0) < (pending.lethal[b] ?? 0)) fail('Assign lethal damage to every blocker before the player');
  }
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
    combat: null, effects: [], pendingTriggers: [], priorityTo: null, pending: null, result: null,
  };
  const ctx: Ctx = { s, reg, events: [], scanned: 0 };
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
  orderTriggers: ['orderTriggers'],
  chooseTargets: ['chooseTargets'],
};

/** Applies one player input. Pure from the caller's view: the given state is never modified. */
export function step(state: GameState, input: PlayerInput, reg: CardRegistry): StepResult {
  if (state.result) return { ok: false, error: 'The game is over' };
  // The state is plain JSON by design (it is persisted and sent over the network), so a JSON copy is exact.
  const ctx: Ctx = { s: JSON.parse(JSON.stringify(state)) as GameState, reg, events: [], scanned: 0 };
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
    scanTriggers(ctx); // events after the last priority check still create triggers for the next one
    return { ok: true, state: ctx.s, events: ctx.events };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
}

function apply(ctx: Ctx, pending: PendingDecision, r: Response): void {
  const p = pending.player;
  const s = ctx.s;
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
    case 'orderTriggers': {
      const ids = (pending as Extract<PendingDecision, { kind: 'orderTriggers' }>).triggers.map((t) => t.id);
      if (r.order.length !== ids.length || new Set(r.order).size !== ids.length || !r.order.every((id) => ids.includes(id))) fail('Order every one of your triggers exactly once');
      // The first to resolve goes on the stack last.
      const stackOrder = [...r.order].reverse().map((id) => ({ ...(s.pendingTriggers.find((t) => t.id === id) as (typeof s.pendingTriggers)[number]), ordered: true }));
      s.pendingTriggers = [...s.pendingTriggers.filter((t) => !ids.includes(t.id)), ...stackOrder];
      givePriority(ctx, s.priorityTo ?? s.turn.active);
      return;
    }
    case 'chooseTargets': {
      const d = pending as Extract<PendingDecision, { kind: 'chooseTargets' }>;
      if (r.targets.length !== d.targetOptions.length) fail(`Expected ${String(d.targetOptions.length)} target(s)`);
      r.targets.forEach((t, i) => { if (!(d.targetOptions[i] ?? []).some((o) => sameTarget(o, t))) fail(`Illegal target #${String(i + 1)}`); });
      stackTrigger(ctx, d.trigger, r.targets);
      givePriority(ctx, s.priorityTo ?? s.turn.active);
      return;
    }
  }
}
