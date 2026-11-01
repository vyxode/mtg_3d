import { seedRng, nextInt, shuffle } from './core/rng';
import { emptyPool, payFromPool, solvePayment } from './mana';
import type {
  CardDef, CardRegistry, CardType, Effect, GameEvent, GameObject, GameState, GrantedAbility, Keyword, PendingTrigger, LegalAction, ManaCost, ManaType, ObjectId,
  PendingDecision, PlayerId, PlayerInput, Resolution, Response, Step, StepResult, Target, TargetSpec, ZoneName,
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
  /** Set when an SBA needs a player's choice (legend rule): priority waits for it. */
  blocked?: boolean;
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
  const types: CardType[] = [...def.types];
  const keywords = [...(def.keywords ?? [])];
  let power = def.power ?? 0;
  let toughness = def.toughness ?? 0;
  if (def.powerIs === 'landsYouControl') { // 604.3, layer 7a: works in every zone
    power = s.zones.battlefield.filter((x) => s.objects[x]?.controller === obj.controller && defOf(reg, s.objects[x].card).types.includes('Land')).length;
  }
  // 613: apply effects layer by layer, each layer in timestamp order (dependencies don't arise with these effects).
  const mine = s.effects.filter((e) => e.affected === id).sort((a, b) => a.timestamp - b.timestamp);
  for (const e of mine) if (e.layer === '4' && !types.includes(e.addType)) types.push(e.addType);
  for (const e of mine) if (e.layer === '6' && e.grant !== 'cantBeBlocked' && !keywords.includes(e.grant)) keywords.push(e.grant);
  const conditional = obj.zone === 'battlefield' ? (def.statics ?? []).flatMap((st) => {
    if (st.kind !== 'ifExiledCardTypes') return [];
    const types = new Set(s.zones.exile.filter((x) => s.objects[x]?.exiledBy === id).flatMap((x) => defOf(reg, (s.objects[x] as GameObject).card).types));
    return types.size >= st.atLeast ? [st] : [];
  }) : [];
  for (const st of conditional) for (const k of st.keywords) if (!keywords.includes(k)) keywords.push(k);
  for (const e of mine) if (e.layer === '7b') { power = e.power; toughness = e.toughness; }
  for (const e of mine) if (e.layer === '7c') { power += e.power; toughness += e.toughness; }
  for (const st of conditional) { power += st.power; toughness += st.toughness; }
  for (const aura of auraStatics(s, reg, id)) { power += aura.power; toughness += aura.toughness; }
  if (obj.zone === 'battlefield' && types.includes('Creature')) {
    power += obj.counters; toughness += obj.counters; // 613.4c
    for (const sid of s.zones.battlefield) { // static anthems (layer 7c), recomputed every time
      const so = s.objects[sid] as GameObject;
      if (so.controller !== obj.controller) continue;
      for (const st of reg.get(so.card)?.statics ?? []) {
        if (st.kind !== 'anthem' || (st.affects === 'otherCreaturesYouControl' && sid === id)) continue;
        power += st.power; toughness += st.toughness;
      }
    }
  }
  return { name: def.name, types, power, toughness, keywords };
}

const isType = (c: { types: readonly string[] }, t: string): boolean => c.types.includes(t);

/** "Enchanted creature gets …" statics of the Auras attached to an object. */
function auraStatics(s: GameState, reg: CardRegistry, id: ObjectId): Extract<NonNullable<CardDef['statics']>[number], { kind: 'enchantedGets' }>[] {
  return s.zones.battlefield
    .filter((a) => s.objects[a]?.attachedTo === id)
    .flatMap((a) => (reg.get((s.objects[a] as GameObject).card)?.statics ?? []).flatMap((st) => (st.kind === 'enchantedGets' ? [st] : [])));
}
const onBattlefield = (s: GameState, id: ObjectId): boolean => s.objects[id]?.zone === 'battlefield';
const isCreatureOnBattlefield = (ctx: Ctx, id: ObjectId): boolean =>
  onBattlefield(ctx.s, id) && isType(characteristics(ctx.s, ctx.reg, id), 'Creature');
const has = (ctx: Ctx, id: ObjectId, kw: Keyword): boolean =>
  ctx.s.objects[id] !== undefined && characteristics(ctx.s, ctx.reg, id).keywords.includes(kw);
const granted = (ctx: Ctx, id: ObjectId, ability: GrantedAbility): boolean =>
  ctx.s.effects.some((e) => e.layer === '6' && e.affected === id && e.grant === ability);
/** Static abilities of permanents `p` controls with this kind. */
const staticsOf = (ctx: Ctx, p: PlayerId, kind: string): number =>
  ctx.s.zones.battlefield.reduce((n, id) => {
    const o = ctx.s.objects[id] as GameObject;
    return o.controller === p ? n + (ctx.reg.get(o.card)?.statics ?? []).filter((st) => st.kind === kind).length : n;
  }, 0);
const controlsWithSubtype = (ctx: Ctx, p: PlayerId, subtype: string): number =>
  ctx.s.zones.battlefield.filter((id) => (ctx.s.objects[id] as GameObject).controller === p && (ctx.reg.get((ctx.s.objects[id] as GameObject).card)?.subtypes ?? []).includes(subtype)).length;

// ---------- Objects and zones ----------

function newObject(ctx: Ctx, card: string, owner: PlayerId, zone: ZoneName): ObjectId {
  const id = `o${String(ctx.s.nextId++)}`;
  ctx.s.objects[id] = {
    id, card, owner, controller: owner, zone,
    tapped: false, damage: 0, summoningSick: true, deathtouchDamage: false, counters: 0, loyalty: 0, loyaltyTurn: 0, timestamp: ctx.s.nextTimestamp++,
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
function moveObject(ctx: Ctx, id: ObjectId, dest: ZoneName, opts: { bottom?: boolean; controller?: PlayerId; payLife?: boolean; transformed?: boolean } = {}): ObjectId {
  const s = ctx.s;
  const obj = s.objects[id] ?? fail(`Unknown object ${id}`);
  let to = dest;
  // 702.34a: a flashback spell is exiled instead of going anywhere else when it leaves the stack.
  if (obj.zone === 'stack' && to !== 'exile' && s.stack.some((e) => e.id === id && e.kind === 'spell' && e.flashback)) to = 'exile';
  // Finality counter: "if a creature with a finality counter on it would die, exile it instead".
  if (obj.zone === 'battlefield' && to === 'graveyard' && (obj.kindCounters?.finality ?? 0) > 0) to = 'exile';
  // 712.8: outside the battlefield (and stack) a double-faced card has only its front face.
  const front = ctx.reg.get(obj.card)?.frontFace;
  const card = to === 'battlefield' && opts.transformed ? defOf(ctx.reg, obj.card).backFace ?? fail(`${obj.card} has no back face`)
    : front !== undefined && to !== 'battlefield' ? front : obj.card;
  const fromList = zoneList(s, obj.zone, obj.owner);
  if (fromList) fromList.splice(fromList.indexOf(id), 1);
  else s.stack = s.stack.filter((e) => e.id !== id);
  Reflect.deleteProperty(s.objects, id);
  s.effects = s.effects.filter((e) => e.affected !== id); // 400.7: effects on the old object don't follow it

  const newId = newObject(ctx, card, obj.owner, to);
  const moved = s.objects[newId] as GameObject;
  moved.controller = opts.controller ?? obj.owner;
  const toList = zoneList(s, to, obj.owner);
  if (toList) {
    if (to === 'library' && !opts.bottom) toList.unshift(newId);
    else toList.push(newId);
  }
  if (to === 'battlefield') {
    moved.loyalty = ctx.reg.get(card)?.loyalty ?? 0; // 306.5b
    moved.counters = ctx.reg.get(card)?.entersWithCounters ?? 0; // 614.1c
  }
  const etb = to === 'battlefield' ? ctx.reg.get(card)?.etb : undefined;
  if (etb && 'tapped' in etb) moved.tapped = true; // 614.1c
  if (etb && 'tappedUnlessYouControlBasicLand' in etb) {
    const basic = s.zones.battlefield.some((x) => x !== newId && (s.objects[x] as GameObject).controller === moved.controller && !!ctx.reg.get((s.objects[x] as GameObject).card)?.supertypes?.includes('Basic'));
    if (!basic) moved.tapped = true;
  }
  if (etb && 'tappedUnlessPayLife' in etb) { // 614.12: the choice is made as it enters
    if (opts.payLife) setLife(ctx, moved.controller, s.players[moved.controller].life - etb.tappedUnlessPayLife);
    else moved.tapped = true;
  }
  ctx.events.push({ kind: 'zoneChange', from: id, to: newId, card, fromZone: obj.zone, toZone: to, owner: obj.owner, lastController: obj.controller });
  if (to === 'battlefield' && ctx.reg.get(card)?.saga) addLore(ctx, newId); // 714.3a: as a Saga enters
  return newId;
}

/** Puts a lore counter on a Saga; its chapter abilities trigger from the event (714.2b). */
function addLore(ctx: Ctx, id: ObjectId): void {
  const o = ctx.s.objects[id] as GameObject;
  const from = o.kindCounters?.lore ?? 0;
  o.kindCounters = { ...o.kindCounters, lore: from + 1 };
  ctx.events.push({ kind: 'loreAdded', id, from, to: from + 1 });
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
  if (d.kind === 'legendRule') ctx.blocked = true;
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
      if (isType(c, 'Planeswalker') && (s.objects[id] as GameObject).loyalty <= 0) { toGraveyard.push(id); continue; } // 704.5i
      if (!isType(c, 'Creature')) continue;
      const o = s.objects[id] as GameObject;
      if (c.toughness <= 0) toGraveyard.push(id); // 704.5f (not destruction: indestructible doesn't help)
      else if (!c.keywords.includes('Indestructible') && (o.damage >= c.toughness || o.deathtouchDamage)) toGraveyard.push(id); // 704.5g, 704.5h
    }
    for (const id of s.zones.battlefield) { // 714.4: a Saga with its last chapter reached and no chapter ability waiting is sacrificed
      const o = s.objects[id] as GameObject;
      const chapters = ctx.reg.get(o.card)?.saga?.length ?? 0;
      const waiting = s.stack.some((e) => e.kind === 'ability' && e.delayed?.subject === id) || s.pendingTriggers.some((t) => t.delayed?.subject === id);
      if (chapters > 0 && (o.kindCounters?.lore ?? 0) >= chapters && !waiting) toGraveyard.push(id);
    }
    for (const id of s.zones.battlefield) { // 704.5m: an Aura attached to nothing, or to something it can't enchant
      const o = s.objects[id] as GameObject;
      const spec = ctx.reg.get(o.card)?.enchant;
      if (!spec) continue;
      const host = o.attachedTo === undefined ? undefined : s.objects[o.attachedTo];
      if (!host || host.zone !== 'battlefield' || !targetOptions(ctx, spec, o.controller).some((t) => t.kind === 'object' && t.id === host.id)) toGraveyard.push(id);
    }
    for (const o of Object.values(s.objects)) o.deathtouchDamage = false; // 704.5h looks only since the last check
    const vanished = Object.values(s.objects).filter((o) => o.zone !== 'battlefield' && ctx.reg.get(o.card)?.token); // 704.5d
    for (const o of vanished) {
      const list = zoneList(s, o.zone, o.owner);
      if (list) list.splice(list.indexOf(o.id), 1);
      Reflect.deleteProperty(s.objects, o.id);
    }
    if (losers.length === 0 && toGraveyard.length === 0) {
      if (vanished.length > 0) { any = true; continue; }
      // shortcut: the legend rule runs after the other SBAs instead of simultaneously, because it needs a choice.
      const legend = findLegendViolation(ctx);
      if (legend) { setPending(ctx, { kind: 'legendRule', player: legend.player, name: legend.name, candidates: legend.ids }); return true; }
      break;
    }
    any = true;
    for (const p of losers) {
      s.players[p].lost = true;
      ctx.events.push({ kind: 'playerLost', player: p, reason: s.players[p].life <= 0 ? 'life' : 'emptyLibrary' });
    }
    for (const id of new Set(toGraveyard)) moveObject(ctx, id, 'graveyard');
  }
  checkGameOver(ctx);
  return any;
}

/** 704.5j: two or more legendary permanents with the same name controlled by one player. */
function findLegendViolation(ctx: Ctx): { player: PlayerId; name: string; ids: ObjectId[] } | null {
  const groups = new Map<string, ObjectId[]>();
  for (const id of ctx.s.zones.battlefield) {
    const o = ctx.s.objects[id] as GameObject;
    if (!ctx.reg.get(o.card)?.supertypes?.includes('Legendary')) continue;
    const key = `${o.controller}|${o.card}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  for (const [key, ids] of groups) {
    if (ids.length > 1) { const [player, name] = key.split('|') as [PlayerId, string]; return { player, name, ids }; }
  }
  return null;
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
    const add = (card: string, source: ObjectId, controller: PlayerId, on: string) => {
      (ctx.reg.get(card)?.triggers ?? []).forEach((t, index) => {
        if (t.on === on && conditionHolds(ctx, t.condition, source)) ctx.s.pendingTriggers.push({ id: `t${String(ctx.s.nextId++)}`, card, source, trigger: index, controller, ordered: false });
      });
    };
    if (e.kind === 'zoneChange' && e.fromZone === 'battlefield' && (e.toZone === 'graveyard' || e.toZone === 'exile')) {
      for (const d of ctx.s.delayedTriggers.filter((x) => x.on === 'subjectDiesOrIsExiled' && x.subject === e.from)) {
        ctx.s.delayedTriggers = ctx.s.delayedTriggers.filter((x) => x.id !== d.id); // it triggers only once (603.7c)
        ctx.s.pendingTriggers.push({ id: d.id, card: d.card, source: e.to, trigger: -1, controller: d.controller, ordered: false, delayed: { effects: d.effects, subject: e.to } });
      }
    }
    if (e.kind === 'loreAdded') {
      const o = ctx.s.objects[e.id];
      const saga = o ? ctx.reg.get(o.card)?.saga ?? [] : [];
      for (let ch = e.from + 1; ch <= e.to && o; ch++) {
        const effects = saga[ch - 1];
        if (effects) ctx.s.pendingTriggers.push({ id: `t${String(ctx.s.nextId++)}`, card: o.card, source: o.id, trigger: -1, controller: o.controller, ordered: false, delayed: { effects, subject: o.id } });
      }
    }
    if (e.kind === 'attackersDeclared') {
      for (const id of e.attackers) { const o = ctx.s.objects[id]; if (o) add(o.card, id, o.controller, 'selfAttacks'); }
    }
    if (e.kind === 'targeted' && e.target.kind === 'object') {
      const o = ctx.s.objects[e.target.id];
      const creature = o && (o.zone === 'battlefield' ? isType(characteristics(ctx.s, ctx.reg, o.id), 'Creature') : o.zone === 'stack' && isType(defOf(ctx.reg, o.card), 'Creature'));
      if (o && creature && o.controller !== e.by) {
        for (const id of ctx.s.zones.battlefield) {
          const src = ctx.s.objects[id] as GameObject;
          if (src.controller === o.controller) add(src.card, id, src.controller, 'creatureYouControlTargetedByOpponent');
        }
      }
    }
    if (e.kind === 'zoneChange' && e.toZone === 'battlefield') {
      const entered = ctx.s.objects[e.to];
      if (entered) {
        add(e.card, e.to, entered.controller, 'selfEntersBattlefield');
        if (isType(defOf(ctx.reg, e.card), 'Land')) { // landfall: every permanent of that land's controller, the land included
          for (const id of ctx.s.zones.battlefield) {
            const o = ctx.s.objects[id] as GameObject;
            if (o.controller === entered.controller) add(o.card, id, o.controller, 'landYouControlEnters');
          }
        }
      }
    }
    if (e.kind === 'tokenCreated') add(e.card, e.id, e.controller, 'selfEntersBattlefield');
    if (e.kind === 'zoneChange' && e.fromZone === 'battlefield' && e.toZone === 'graveyard') add(e.card, e.from, e.lastController, 'selfDies');
    if (e.kind === 'lifeChanged' && e.to > e.from) { // "Whenever you gain life" (603.2)
      for (const id of ctx.s.zones.battlefield) {
        const o = ctx.s.objects[id] as GameObject;
        if (o.controller === e.player) add(o.card, id, e.player, 'controllerGainsLife');
      }
    }
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
      const def = t.delayed ? { targets: [], upToOne: undefined } : defOf(ctx.reg, t.card).triggers?.[t.trigger] ?? fail('Unknown trigger');
      const options = def.targets.map((spec) => targetOptions(ctx, spec, p));
      if (def.upToOne) { // the targets may be left unchosen: ask unless there is nothing to choose
        if (options.every((o) => o.length === 0)) { stackTrigger(ctx, t.id, []); continue; }
        setPending(ctx, { kind: 'chooseTargets', player: p, trigger: t.id, card: t.card, targetOptions: options, optional: true });
        return false;
      }
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
  s.stack.push({ kind: 'ability', id: t.id, card: t.card, source: t.source, ability: { kind: 'trigger', index: t.trigger }, controller: t.controller, targets, ...(t.delayed && { delayed: t.delayed }) });
  ctx.events.push({ kind: 'triggered', card: t.card, controller: t.controller, ability: t.id });
  announceTargets(ctx, t.controller, targets);
}

/** 603.4: an intervening "if" clause. */
function conditionHolds(ctx: Ctx, c: TriggerCondition | undefined, source: ObjectId): boolean {
  if (!c) return true;
  return (ctx.s.objects[source]?.kindCounters?.[c.selfCounters] ?? 0) >= c.atLeast;
}

type TriggerCondition = NonNullable<NonNullable<CardDef['triggers']>[number]['condition']>;

/** "Becomes the target" events for every target of a spell or ability just put on the stack. */
function announceTargets(ctx: Ctx, by: PlayerId, targets: Target[]): void {
  for (const target of targets) ctx.events.push({ kind: 'targeted', by, target });
}

// ---------- Priority ----------

/** 117.5: before a player receives priority, SBAs are performed and triggers go on the stack, repeatedly. */
function givePriority(ctx: Ctx, p: PlayerId): void {
  ctx.s.priorityTo = p;
  for (;;) {
    scanTriggers(ctx); // abilities trigger when their event happens (603.2), before SBAs run (e.g. a Saga's last chapter, 714.4)
    runSBA(ctx);
    if (ctx.s.result || ctx.blocked) return;
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

function targetOptions(ctx: Ctx, spec: TargetSpec, controller: PlayerId): Target[] {
  const s = ctx.s;
  const creatures = s.zones.battlefield.filter((id) => isCreatureOnBattlefield(ctx, id)).map((id): Target => ({ kind: 'object', id }));
  const players = (['p1', 'p2'] as const).filter((p) => !s.players[p].lost).map((p): Target => ({ kind: 'player', player: p }));
  const walkers = s.zones.battlefield.filter((id) => isType(characteristics(s, ctx.reg, id), 'Planeswalker')).map((id): Target => ({ kind: 'object', id }));
  switch (spec) {
    case 'player': return players;
    case 'anyTarget': return [...players, ...creatures, ...walkers]; // 115.4
    case 'creature': return creatures;
    case 'creatureYouControl': return creatures.filter((t) => t.kind === 'object' && (s.objects[t.id] as GameObject).controller === controller);
    case 'creaturePowerAtMost2': return creatures.filter((t) => t.kind === 'object' && characteristics(s, ctx.reg, t.id).power <= 2);
    case 'creatureOpponentControls': return creatures.filter((t) => t.kind === 'object' && (s.objects[t.id] as GameObject).controller !== controller);
    case 'nonbasicLandOpponentControls':
      return s.zones.battlefield.filter((id) => {
        const o = s.objects[id] as GameObject;
        return o.controller !== controller && isType(characteristics(s, ctx.reg, id), 'Land') && !ctx.reg.get(o.card)?.supertypes?.includes('Basic');
      }).map((id): Target => ({ kind: 'object', id }));
    case 'cardInGraveyard': return [...s.zones.graveyard.p1, ...s.zones.graveyard.p2].map((id): Target => ({ kind: 'object', id }));
    case 'landYouControl':
      return s.zones.battlefield.filter((id) => (s.objects[id] as GameObject).controller === controller && isType(characteristics(s, ctx.reg, id), 'Land')).map((id): Target => ({ kind: 'object', id }));
    case 'spell': return s.stack.filter((e) => e.kind === 'spell').map((e): Target => ({ kind: 'object', id: e.id }));
  }
}

function isLegalTarget(ctx: Ctx, spec: TargetSpec, t: Target, self: ObjectId | null, controller: PlayerId): boolean {
  if (t.kind === 'object' && t.id === self) return false; // 115.5: a spell can't target itself
  return targetOptions(ctx, spec, controller).some((o) => sameTarget(o, t));
}

const sameTarget = (a: Target, b: Target): boolean =>
  a.kind === 'player' ? b.kind === 'player' && a.player === b.player : b.kind === 'object' && a.id === b.id;

/** 302.6: summoning sickness stops attacking and {T} abilities, unless the creature has haste (702.10). */
const isSick = (ctx: Ctx, id: ObjectId): boolean => (ctx.s.objects[id] as GameObject).summoningSick && !has(ctx, id, 'Haste');

function canActivateMana(ctx: Ctx, p: PlayerId, id: ObjectId): boolean {
  const obj = ctx.s.objects[id];
  if (obj?.zone !== 'battlefield' || obj.controller !== p || obj.tapped) return false;
  if (!defOf(ctx.reg, obj.card).manaAbilities?.length) return false;
  return !(isType(characteristics(ctx.s, ctx.reg, id), 'Creature') && isSick(ctx, id));
}

function legalActions(ctx: Ctx, p: PlayerId): LegalAction[] {
  const s = ctx.s;
  const out: LegalAction[] = [];
  const sorcerySpeed = canCastSorcerySpeed(ctx, p);
  const canPlayLand = sorcerySpeed && s.turn.landsPlayed < landsAllowed(ctx, p);
  for (const id of s.zones.hand[p]) {
    const def = defOf(ctx.reg, (s.objects[id] as GameObject).card);
    if (isType(def, 'Land')) {
      if (canPlayLand) out.push({ kind: 'playLand', card: id });
      continue;
    }
    if (!isType(def, 'Instant') && !sorcerySpeed) continue;
    const opts = spellTargets(def).map((spec) => targetOptions(ctx, spec, p));
    if (!opts.every((o) => o.length > 0)) continue;
    if (def.manaCost !== null) out.push({ kind: 'cast', card: id, targetOptions: opts, cost: costToCast(ctx, p, def) }); // 202.1b
    if (def.warp) out.push({ kind: 'cast', card: id, targetOptions: opts, cost: def.warp, warp: true });
  }
  for (const id of s.zones.graveyard[p]) { // 702.34a flashback
    const def = defOf(ctx.reg, (s.objects[id] as GameObject).card);
    if (!def.flashback || (!isType(def, 'Instant') && !sorcerySpeed)) continue;
    const opts = spellTargets(def).map((spec) => targetOptions(ctx, spec, p));
    if (opts.every((x) => x.length > 0)) out.push({ kind: 'cast', card: id, targetOptions: opts, cost: def.flashback, flashback: true });
  }
  for (const id of s.zones.exile) {
    const o = s.objects[id] as GameObject;
    if (!castableFromExile(ctx, p, o)) continue;
    const def = defOf(ctx.reg, o.card);
    if (!isType(def, 'Instant') && !sorcerySpeed) continue;
    const opts = spellTargets(def).map((spec) => targetOptions(ctx, spec, p));
    if (opts.every((x) => x.length > 0)) out.push({ kind: 'cast', card: id, targetOptions: opts, cost: costToCast(ctx, p, def) });
  }
  if (canPlayLand && staticsOf(ctx, p, 'playLandsFromGraveyard') > 0) {
    for (const id of s.zones.graveyard[p]) if (isType(defOf(ctx.reg, (s.objects[id] as GameObject).card), 'Land')) out.push({ kind: 'playLand', card: id });
  }
  for (const id of s.zones.battlefield) {
    if (canActivateMana(ctx, p, id)) out.push({ kind: 'activateMana', source: id });
    const o = s.objects[id] as GameObject;
    if (o.controller !== p) continue;
    defOf(ctx.reg, o.card).activated?.forEach((ab, ability) => {
      if (ab.cost.tap && !canTapForCost(ctx, id)) return;
      if (ab.sorcerySpeed && !sorcerySpeed) return;
      if (ab.cost.crew !== undefined && crewPower(ctx, crewCandidates(ctx, p, id)) < ab.cost.crew) return;
      if (ab.cost.loyalty !== undefined && !canPayLoyalty(ctx, p, id, ab.cost.loyalty)) return;
      const opts = ab.targets.map((spec) => targetOptions(ctx, spec, p));
      if (opts.every((x) => x.length > 0)) out.push({ kind: 'activate', source: id, ability, targetOptions: opts });
    });
  }
  return out;
}

/** Untapped creatures that could crew a Vehicle (702.122a): any of yours but the Vehicle itself; summoning sickness doesn't matter. */
const crewCandidates = (ctx: Ctx, p: PlayerId, vehicle: ObjectId): ObjectId[] =>
  ctx.s.zones.battlefield.filter((id) => id !== vehicle && (ctx.s.objects[id] as GameObject).controller === p && !(ctx.s.objects[id] as GameObject).tapped && isCreatureOnBattlefield(ctx, id));
const crewPower = (ctx: Ctx, crew: ObjectId[]): number =>
  crew.reduce((n, id) => n + Math.max(0, characteristics(ctx.s, ctx.reg, id).power), 0);

/** A spell's targets: an Aura spell targets what it will enchant (303.4a). */
const spellTargets = (def: CardDef): TargetSpec[] => (def.enchant ? [def.enchant] : def.spell?.targets ?? []);

/** 702.185a: a card exiled with warp may be cast by its owner after the turn it was exiled on. */
const castableFromExile = (ctx: Ctx, p: PlayerId, o: GameObject): boolean =>
  o.zone === 'exile' && o.owner === p && o.warpExiledTurn !== undefined && o.warpExiledTurn < ctx.s.turn.number;

/** 305.2: one land per turn, plus one for each "additional land" effect. */
const landsAllowed = (ctx: Ctx, p: PlayerId): number => 1 + staticsOf(ctx, p, 'extraLandDrop');

/** The mana cost after reductions (601.2f): affinity (702.41) reduces only the generic part. */
function costToCast(ctx: Ctx, p: PlayerId, def: CardDef): ManaCost {
  const cost = def.manaCost ?? { generic: 0 };
  if (!def.affinityFor) return cost;
  return { ...cost, generic: Math.max(0, cost.generic - controlsWithSubtype(ctx, p, def.affinityFor)) };
}

const manaOptions = (ctx: Ctx, id: ObjectId): ManaType[] =>
  defOf(ctx.reg, (ctx.s.objects[id] as GameObject).card).manaAbilities?.[0]?.produce ?? [];

function activateMana(ctx: Ctx, p: PlayerId, id: ObjectId, mana?: ManaType): void {
  if (!canActivateMana(ctx, p, id)) fail(`Cannot activate a mana ability of ${id}`);
  const options = manaOptions(ctx, id);
  const m = mana ?? options[0] ?? fail('No mana ability');
  if (!options.includes(m)) fail(`That source cannot produce ${m}`);
  tap(ctx, id);
  ctx.s.players[p].manaPool[m] += 1;
  ctx.events.push({ kind: 'manaAdded', player: p, mana: m });
}

/** 601.2g-h: activates the given mana sources (choosing colors that work), then pays the cost from the pool. */
function payCost(ctx: Ctx, p: PlayerId, payment: ObjectId[], cost: ManaCost): void {
  if (new Set(payment).size !== payment.length) fail('Duplicate mana source');
  const sources = payment.map((id) => {
    if (!canActivateMana(ctx, p, id)) fail(`Cannot activate a mana ability of ${id}`);
    return { id, produce: manaOptions(ctx, id) };
  });
  const plan = solvePayment(ctx.s.players[p].manaPool, sources, cost) ?? fail('Not enough mana');
  for (const src of sources) activateMana(ctx, p, src.id, plan.find((x) => x.id === src.id)?.mana);
  ctx.s.players[p].manaPool = payFromPool(ctx.s.players[p].manaPool, cost) ?? fail('Not enough mana');
}

/** Can the {T} in a cost be paid? 302.6 applies to creatures. */
const canTapForCost = (ctx: Ctx, id: ObjectId): boolean => {
  const o = ctx.s.objects[id] as GameObject;
  return !o.tapped && !(isType(characteristics(ctx.s, ctx.reg, id), 'Creature') && isSick(ctx, id));
};

/** 606.3: sorcery speed, once per turn per planeswalker, and a minus cost needs enough loyalty. */
function canPayLoyalty(ctx: Ctx, p: PlayerId, id: ObjectId, cost: number): boolean {
  const o = ctx.s.objects[id] as GameObject;
  return canCastSorcerySpeed(ctx, p) && o.loyaltyTurn !== ctx.s.turn.number && o.loyalty + cost >= 0;
}

function activate(ctx: Ctx, p: PlayerId, r: Extract<Response, { kind: 'activate' }>): void {
  const s = ctx.s;
  const obj = s.objects[r.source];
  if (obj?.zone !== 'battlefield' || obj.controller !== p) fail('You do not control that permanent');
  const ab = defOf(ctx.reg, (obj as GameObject).card).activated?.[r.ability] ?? fail('No such ability');
  if (r.targets.length !== ab.targets.length) fail(`Expected ${String(ab.targets.length)} target(s)`);
  ab.targets.forEach((spec, i) => { if (!isLegalTarget(ctx, spec, r.targets[i] as Target, null, p)) fail(`Illegal target #${String(i + 1)}`); });
  if ((ab.cost.sacrifice || ab.cost.exile) && r.payment.includes(r.source)) fail('A permanent you sacrifice or exile cannot also pay mana');
  if (ab.cost.tap) {
    if (!canTapForCost(ctx, r.source)) fail('It cannot be tapped to pay this cost');
    if (r.payment.includes(r.source)) fail('The same permanent cannot also tap for mana');
  }
  if (ab.cost.loyalty !== undefined && !canPayLoyalty(ctx, p, r.source, ab.cost.loyalty)) fail('That loyalty ability cannot be activated now');
  if (ab.sorcerySpeed && !canCastSorcerySpeed(ctx, p)) fail('That ability can only be activated as a sorcery');
  const crew = r.crew ?? [];
  if (ab.cost.crew !== undefined) {
    const allowed = crewCandidates(ctx, p, r.source);
    if (new Set(crew).size !== crew.length || !crew.every((id) => allowed.includes(id))) fail('Crew with untapped creatures you control');
    if (crewPower(ctx, crew) < ab.cost.crew) fail(`Crew needs total power ${String(ab.cost.crew)} or more`);
    if (crew.some((id) => r.payment.includes(id))) fail('A creature that crews cannot also tap for mana');
  }
  payCost(ctx, p, r.payment, ab.cost.mana ?? { generic: 0 });
  if (ab.cost.tap) tap(ctx, r.source);
  for (const id of crew) tap(ctx, id);
  if (ab.cost.loyalty !== undefined) {
    const o = s.objects[r.source] as GameObject;
    o.loyalty += ab.cost.loyalty;
    o.loyaltyTurn = s.turn.number;
  }
  if (ab.cost.sacrifice) moveObject(ctx, r.source, 'graveyard'); // 701.21: sacrificing is not destroying
  if (ab.cost.exile) moveObject(ctx, r.source, 'exile');
  const id = `a${String(s.nextId++)}`;
  s.stack.push({ kind: 'ability', id, card: (obj as GameObject).card, source: r.source, ability: { kind: 'activated', index: r.ability }, controller: p, targets: r.targets });
  ctx.events.push({ kind: 'activated', card: (obj as GameObject).card, controller: p, ability: id });
  announceTargets(ctx, p, r.targets);
  afterAction(ctx, p);
}

function onPass(ctx: Ctx, p: PlayerId): void {
  const t = ctx.s.turn;
  t.passed.push(p);
  if (!t.passed.includes(other(p))) { givePriority(ctx, other(p)); return; }
  // 117.4: all players passed in succession
  if (ctx.s.stack.length > 0) {
    if (resolveTop(ctx)) afterResolution(ctx); // otherwise it waits for a choice made while resolving
  } else {
    endStep(ctx);
  }
}

function afterResolution(ctx: Ctx): void {
  ctx.s.turn.passed = [];
  givePriority(ctx, ctx.s.turn.active); // 117.3b
}

function afterAction(ctx: Ctx, p: PlayerId): void {
  ctx.s.turn.passed = [];
  givePriority(ctx, p); // 117.3c: the player who acted receives priority
}

// ---------- Casting (601.2) and resolution (608) ----------

function playLand(ctx: Ctx, p: PlayerId, id: ObjectId, payLife: boolean | undefined): void {
  const obj = ctx.s.objects[id];
  const fromGraveyard = obj?.zone === 'graveyard' && staticsOf(ctx, p, 'playLandsFromGraveyard') > 0;
  if ((obj?.zone !== 'hand' && !fromGraveyard) || obj.owner !== p) fail('You cannot play that card from where it is');
  if (!isType(defOf(ctx.reg, (obj as GameObject).card), 'Land')) fail('Only lands can be played');
  if (!canCastSorcerySpeed(ctx, p)) fail('Lands can only be played in your main phase with an empty stack');
  if (ctx.s.turn.landsPlayed >= landsAllowed(ctx, p)) fail('You already played all the lands you can this turn');
  ctx.s.turn.landsPlayed += 1;
  moveObject(ctx, id, 'battlefield', { controller: p, payLife: payLife === true });
  afterAction(ctx, p);
}

function cast(ctx: Ctx, p: PlayerId, r: Extract<Response, { kind: 'cast' }>): void {
  const s = ctx.s;
  const obj = s.objects[r.card] ?? fail('Unknown card');
  const fromExile = castableFromExile(ctx, p, obj);
  const def = defOf(ctx.reg, obj.card);
  const flashback = r.flashback === true && obj.zone === 'graveyard' && !!def.flashback;
  if (r.flashback && !flashback) fail('Only a card with flashback in your graveyard can be cast with flashback');
  if ((obj.zone !== 'hand' && !fromExile && !flashback) || obj.owner !== p) fail('You cannot cast that card from where it is');
  if (def.status === 'unsupported') fail(`${def.name} is not implemented`);
  if (r.warp && (obj.zone !== 'hand' || !def.warp)) fail('Only a card with warp in your hand can be cast for its warp cost');
  if (isType(def, 'Land')) fail('Lands are played, not cast');
  if (!isType(def, 'Instant') && !canCastSorcerySpeed(ctx, p)) fail(`${def.name} can only be cast at sorcery speed`);

  const specs = spellTargets(def);
  if (r.targets.length !== specs.length) fail(`Expected ${String(specs.length)} target(s)`);
  specs.forEach((spec, i) => { if (!isLegalTarget(ctx, spec, r.targets[i] as Target, null, p)) fail(`Illegal target #${String(i + 1)}`); });

  if (def.manaCost === null && !flashback && !r.warp) fail(`${def.name} has no mana cost and can't be cast normally`); // 202.1b
  payCost(ctx, p, r.payment, flashback && def.flashback ? def.flashback : r.warp && def.warp ? def.warp : costToCast(ctx, p, def));

  const spell = moveObject(ctx, r.card, 'stack', { controller: p });
  s.stack.push({ kind: 'spell', id: spell, card: def.name, controller: p, targets: r.targets, ...(r.warp && { warp: true as const }), ...(flashback && { flashback: true as const }) });
  ctx.events.push({ kind: 'cast', player: p, spell, targets: r.targets });
  announceTargets(ctx, p, r.targets);
  afterAction(ctx, p);
}

/** Resolves the top of the stack (608). Returns false if it stopped for a choice; the answer continues it. */
function resolveTop(ctx: Ctx): boolean {
  const s = ctx.s;
  const entry = s.stack[s.stack.length - 1] ?? fail('Empty stack');
  const def = defOf(ctx.reg, entry.card);

  if (entry.kind === 'ability') {
    s.stack.pop();
    const ability = entry.delayed ? { targets: [], effects: entry.delayed.effects, condition: undefined }
      : (entry.ability.kind === 'trigger' ? def.triggers?.[entry.ability.index] : def.activated?.[entry.ability.index]) ?? fail('Unknown ability');
    if ('condition' in ability && !conditionHolds(ctx, ability.condition, entry.source)) { ctx.events.push({ kind: 'resolved', spell: entry.id }); return true; } // 603.4
    // Unchosen "up to one" targets are simply absent; only chosen ones can make it fizzle (608.2b).
    const legal = ability.targets.map((spec, i) => i < entry.targets.length && isLegalTarget(ctx, spec, entry.targets[i] as Target, null, entry.controller));
    if (entry.targets.length > 0 && legal.every((l) => !l)) { ctx.events.push({ kind: 'fizzled', spell: entry.id }); return true; }
    s.resolving = { entry, effects: ability.effects, targets: entry.targets, legal, targetControllers: controllersOf(ctx, entry.targets), next: 0 };
    return continueResolution(ctx);
  }

  if (!def.spell) { // permanent spell
    if (def.enchant && !isLegalTarget(ctx, def.enchant, entry.targets[0] as Target, entry.id, entry.controller)) { // 608.3b
      ctx.events.push({ kind: 'fizzled', spell: entry.id });
      moveObject(ctx, entry.id, 'graveyard');
      return true;
    }
    const permanent = moveObject(ctx, entry.id, 'battlefield', { controller: entry.controller });
    const host = entry.targets[0];
    if (def.enchant && host?.kind === 'object') (s.objects[permanent] as GameObject).attachedTo = host.id; // 303.4f
    if (entry.warp) { // 702.185a: exile it at the beginning of the next end step
      s.delayedTriggers.push({
        id: `d${String(s.nextId++)}`, card: entry.card, controller: entry.controller, subject: permanent, on: 'nextEndStep',
        createdTurn: s.turn.number, createdDuringEnd: s.turn.step === 'end' || s.turn.step === 'cleanup', effects: [{ kind: 'exileSubjectWarp' }],
      });
    }
    ctx.events.push({ kind: 'resolved', spell: entry.id });
    return true;
  }
  const specs = def.spell.targets;
  const legal = specs.map((spec, i) => isLegalTarget(ctx, spec, entry.targets[i] as Target, entry.id, entry.controller));
  if (specs.length > 0 && legal.every((l) => !l)) { // 608.2b
    ctx.events.push({ kind: 'fizzled', spell: entry.id });
    moveObject(ctx, entry.id, 'graveyard');
    return true;
  }
  s.resolving = { entry, effects: def.spell.effects, targets: entry.targets, legal, targetControllers: controllersOf(ctx, entry.targets), next: 0 };
  return continueResolution(ctx);
}

/** Performs the remaining effects of the resolving spell or ability; false if one of them needs a choice first. */
function continueResolution(ctx: Ctx): boolean {
  const s = ctx.s;
  const r = s.resolving ?? fail('Nothing is resolving');
  while (r.next < r.effects.length) {
    const effect = r.effects[r.next] as Effect;
    r.next += 1;
    if (!runEffect(ctx, effect, r)) return false;
  }
  s.resolving = null;
  ctx.events.push({ kind: 'resolved', spell: r.entry.id });
  if (r.entry.kind === 'spell' && s.objects[r.entry.id]?.zone === 'stack') moveObject(ctx, r.entry.id, 'graveyard'); // 608.2n
  return true;
}

const controllersOf = (ctx: Ctx, targets: Target[]): (PlayerId | null)[] =>
  targets.map((t) => (t.kind === 'object' ? ctx.s.objects[t.id]?.controller ?? null : null));

const sourceOf = (r: Resolution): ObjectId => (r.entry.kind === 'spell' ? r.entry.id : r.entry.source);

/** One effect of a resolving spell or ability. Returns false when it set a decision (the answer finishes the effect). */
function runEffect(ctx: Ctx, effect: Effect, r: Resolution): boolean {
  const s = ctx.s;
  const controller = r.entry.controller;
  const source = sourceOf(r);
  const ti = 'target' in effect && typeof effect.target === 'number' ? effect.target : null;
  if (ti !== null && !r.legal[ti]) return true; // illegal targets are unaffected (608.2b)
  const t = ti !== null ? (r.targets[ti] as Target) : null;
  const objectTarget = () => (t as Extract<Target, { kind: 'object' }>).id;
  const untilEndOfTurn = (affected: ObjectId, grant: GrantedAbility) => {
    s.effects.push({ layer: '6', affected, grant, duration: 'endOfTurn', timestamp: s.nextTimestamp++ });
  };
  switch (effect.kind) {
    case 'damage': dealDamage(ctx, source, t as Target, effect.amount, false); break;
    case 'draw': for (let i = 0; i < effect.amount; i++) draw(ctx, controller); break;
    case 'drawEach': for (const p of [s.turn.active, other(s.turn.active)]) for (let i = 0; i < effect.amount; i++) draw(ctx, p); break; // APNAP
    case 'targetDraws': for (let i = 0; i < effect.amount; i++) draw(ctx, (t as Extract<Target, { kind: 'player' }>).player); break;
    case 'mill': {
      const p = effect.target === 'you' ? controller : (t as Extract<Target, { kind: 'player' }>).player;
      for (const id of s.zones.library[p].slice(0, effect.amount)) moveObject(ctx, id, 'graveyard'); // 701.17
      break;
    }
    case 'gainLife': setLife(ctx, controller, s.players[controller].life + effect.amount); break;
    case 'destroy': { // 701.8: indestructible permanents are not destroyed
      const id = objectTarget();
      if (!has(ctx, id, 'Indestructible')) moveObject(ctx, id, 'graveyard');
      break;
    }
    case 'createToken':
      for (let i = 0; i < effect.amount; i++) {
        const id = newObject(ctx, defOf(ctx.reg, effect.token).name, controller, 'battlefield');
        s.zones.battlefield.push(id);
        ctx.events.push({ kind: 'tokenCreated', id, card: effect.token, controller });
      }
      break;
    case 'addCounters': {
      const id = effect.target === 'self' ? source : objectTarget();
      const o = s.objects[id];
      if (o?.zone !== 'battlefield') break; // the source left: nothing to put counters on
      if (effect.counter) {
        o.kindCounters = { ...o.kindCounters, [effect.counter]: (o.kindCounters?.[effect.counter] ?? 0) + effect.amount };
        break;
      }
      o.counters += effect.amount;
      ctx.events.push({ kind: 'countersAdded', id, amount: effect.amount });
      break;
    }
    case 'earthbend': {
      const id = objectTarget();
      const ts = () => s.nextTimestamp++;
      s.effects.push(
        { layer: '4', affected: id, addType: 'Creature', duration: 'permanent', timestamp: ts() },
        { layer: '6', affected: id, grant: 'Haste', duration: 'permanent', timestamp: ts() },
        { layer: '7b', affected: id, power: 0, toughness: 0, duration: 'permanent', timestamp: ts() },
      );
      (s.objects[id] as GameObject).counters += effect.amount;
      ctx.events.push({ kind: 'countersAdded', id, amount: effect.amount });
      s.delayedTriggers.push({
        id: `d${String(s.nextId++)}`, card: r.entry.card, controller, subject: id, on: 'subjectDiesOrIsExiled',
        createdTurn: s.turn.number, createdDuringEnd: false, effects: [{ kind: 'returnSubjectTapped' }],
      });
      break;
    }
    case 'reflexive': {
      const t = defOf(ctx.reg, r.entry.card).triggers?.[effect.trigger] ?? fail('Unknown reflexive trigger');
      if (conditionHolds(ctx, t.condition, source)) s.pendingTriggers.push({ id: `t${String(s.nextId++)}`, card: r.entry.card, source, trigger: effect.trigger, controller, ordered: false });
      break;
    }
    case 'returnSubjectTapped': {
      const subject = r.entry.kind === 'ability' ? r.entry.delayed?.subject : undefined;
      const o = subject === undefined ? undefined : s.objects[subject];
      if (o?.zone !== 'graveyard' && o?.zone !== 'exile') break; // it moved again: it can't be found (400.7)
      const back = moveObject(ctx, o.id, 'battlefield');
      (s.objects[back] as GameObject).tapped = true;
      break;
    }
    case 'exileSubjectWarp': {
      const subject = r.entry.kind === 'ability' ? r.entry.delayed?.subject : undefined;
      if (subject === undefined || s.objects[subject]?.zone !== 'battlefield') break;
      const exiled = moveObject(ctx, subject, 'exile');
      (s.objects[exiled] as GameObject).warpExiledTurn = s.turn.number;
      break;
    }
    case 'doubleCounters': {
      const o = s.objects[source];
      if (o?.zone !== 'battlefield' || o.counters === 0) break;
      const amount = o.counters;
      o.counters += amount;
      ctx.events.push({ kind: 'countersAdded', id: source, amount });
      break;
    }
    case 'counter': {
      const target = objectTarget();
      if (ctx.reg.get((s.objects[target] as GameObject).card)?.cantBeCountered) break; // 101.6
      ctx.events.push({ kind: 'countered', spell: target });
      moveObject(ctx, target, 'graveyard');
      break;
    }
    case 'pump':
      s.effects.push({ layer: '7c', affected: objectTarget(), power: effect.power, toughness: effect.toughness, duration: 'endOfTurn', timestamp: s.nextTimestamp++ });
      break;
    case 'doublePower': {
      const id = objectTarget();
      s.effects.push({ layer: '7c', affected: id, power: characteristics(s, ctx.reg, id).power, toughness: 0, duration: 'endOfTurn', timestamp: s.nextTimestamp++ });
      break;
    }
    case 'grant': untilEndOfTurn(objectTarget(), effect.ability); break;
    case 'grantAll':
      for (const id of s.zones.battlefield) {
        const o = s.objects[id] as GameObject;
        if (o.controller === controller && (ctx.reg.get(o.card)?.subtypes ?? []).some((st) => effect.subtypes.includes(st))) untilEndOfTurn(id, effect.ability);
      }
      break;
    case 'surveil': {
      const top = s.zones.library[controller].slice(0, effect.amount);
      if (top.length === 0) break;
      setPending(ctx, { kind: 'surveil', player: controller, source: r.entry.card, cards: top.map((id) => (s.objects[id] as GameObject).card) });
      return false;
    }
    case 'transformOntoBattlefieldIfCastFromGraveyard': {
      if (r.entry.kind !== 'spell' || !r.entry.flashback || s.objects[r.entry.id]?.zone !== 'stack') break;
      const exiled = moveObject(ctx, r.entry.id, 'exile');
      const owner = (s.objects[exiled] as GameObject).owner;
      const back = moveObject(ctx, exiled, 'battlefield', { controller: owner, transformed: true });
      const o = s.objects[back] as GameObject;
      o.kindCounters = { ...o.kindCounters, finality: 1 };
      break;
    }
    case 'revealTopPermanentToHand': {
      const top = s.zones.library[controller][0];
      if (top === undefined) break;
      const card = (s.objects[top] as GameObject).card;
      ctx.events.push({ kind: 'revealed', player: controller, card });
      const permanent = defOf(ctx.reg, card).types.some((t) => t !== 'Instant' && t !== 'Sorcery'); // 110.4a
      if (permanent) moveObject(ctx, top, 'hand');
      break;
    }
    case 'addMana':
      for (const m of effect.mana) { s.players[controller].manaPool[m] += 1; ctx.events.push({ kind: 'manaAdded', player: controller, mana: m }); }
      break;
    case 'pumpOthers':
      for (const id of s.zones.battlefield) {
        if (id === source || (s.objects[id] as GameObject).controller !== controller || !isCreatureOnBattlefield(ctx, id)) continue;
        s.effects.push({ layer: '7c', affected: id, power: effect.power, toughness: effect.toughness, duration: 'endOfTurn', timestamp: s.nextTimestamp++ });
        if (effect.grant) untilEndOfTurn(id, effect.grant);
      }
      break;
    case 'becomeCreature':
      if (onBattlefield(s, source)) s.effects.push({ layer: '4', affected: source, addType: 'Creature', duration: 'endOfTurn', timestamp: s.nextTimestamp++ });
      break;
    case 'enchantedFights': { // 701.14b: no damage if either is no longer a creature on the battlefield
      const host = s.objects[source]?.attachedTo;
      const other = objectTarget();
      if (host === undefined || !isCreatureOnBattlefield(ctx, host) || !isCreatureOnBattlefield(ctx, other)) break;
      const [hp, op] = [characteristics(s, ctx.reg, host).power, characteristics(s, ctx.reg, other).power];
      dealDamage(ctx, host, { kind: 'object', id: other }, hp, false);
      dealDamage(ctx, other, { kind: 'object', id: host }, op, false);
      break;
    }
    case 'exileTarget': {
      const exiled = moveObject(ctx, objectTarget(), 'exile');
      if (effect.track) (s.objects[exiled] as GameObject).exiledBy = source;
      break;
    }
    case 'searchBasicLand': {
      const searcher = effect.who === 'targetController' ? r.targetControllers[effect.target ?? 0] ?? null : controller;
      if (searcher === null) break;
      const cards = [...new Set(s.zones.library[searcher].map((id) => (s.objects[id] as GameObject).card))]
        .filter((card) => defOf(ctx.reg, card).supertypes?.includes('Basic') && isType(defOf(ctx.reg, card), 'Land'));
      if (cards.length === 0) { finishSearch(ctx, effect, searcher, null); break; }
      setPending(ctx, { kind: 'searchLibrary', player: searcher, source: r.entry.card, cards });
      return false;
    }
  }
  return true;
}

/** The rest of a library search once the card is chosen (or none): put it onto the battlefield, then shuffle (701.23). */
function finishSearch(ctx: Ctx, effect: Extract<Effect, { kind: 'searchBasicLand' }>, p: PlayerId, card: string | null): void {
  let found: ObjectId | null = null;
  // Copies of a card in a library are indistinguishable, so the choice is a name and any copy is taken.
  const copy = card === null ? undefined : ctx.s.zones.library[p].find((id) => ctx.s.objects[id]?.card === card);
  if (copy !== undefined) {
    found = moveObject(ctx, copy, 'battlefield', { controller: p });
    const o = ctx.s.objects[found] as GameObject;
    if (effect.tapped) o.tapped = true;
  }
  ctx.events.push({ kind: 'searched', player: p, found });
  shuffleLibrary(ctx, p);
  if (found !== null && effect.untapIfLands !== undefined) {
    const lands = ctx.s.zones.battlefield.filter((id) => (ctx.s.objects[id] as GameObject).controller === p && isType(characteristics(ctx.s, ctx.reg, id), 'Land')).length;
    const o = ctx.s.objects[found] as GameObject;
    if (lands >= effect.untapIfLands && o.tapped) { o.tapped = false; ctx.events.push({ kind: 'untapped', id: found }); }
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
    if (isType(characteristics(ctx.s, ctx.reg, target.id), 'Planeswalker')) o.loyalty -= amount; // 306.8 (120.3c)
    else o.damage += amount;
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
      else {
        const planeswalkers = s.zones.battlefield.filter((id) => (s.objects[id] as GameObject).controller !== active && isType(characteristics(s, ctx.reg, id), 'Planeswalker'));
        setPending(ctx, { kind: 'declareAttackers', player: active, candidates, planeswalkers });
      }
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
    case 'main1': // 714.3b: as the precombat main phase begins, its player adds a lore counter to each of their Sagas
      for (const id of s.zones.battlefield) {
        const o = s.objects[id] as GameObject;
        if (o.controller === active && ctx.reg.get(o.card)?.saga) addLore(ctx, id);
      }
      givePriority(ctx, active);
      return;
    case 'end': { // 513.1: "at the beginning of the (next) end step" triggers
      for (const d of s.delayedTriggers.filter((x) => x.on === 'nextEndStep' && !(x.createdTurn === s.turn.number && x.createdDuringEnd))) {
        s.delayedTriggers = s.delayedTriggers.filter((x) => x.id !== d.id);
        s.pendingTriggers.push({ id: d.id, card: d.card, source: d.subject, trigger: -1, controller: d.controller, ordered: false, delayed: { effects: d.effects, subject: d.subject } } satisfies PendingTrigger);
      }
      givePriority(ctx, active);
      return;
    }
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
  s.effects = s.effects.filter((e) => e.duration !== 'endOfTurn'); // 514.2
  s.priorityTo = s.turn.active;
  scanTriggers(ctx);
  const acted = runSBA(ctx);
  if (ctx.blocked) return;
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
  if (granted(ctx, attacker, 'cantBeBlocked')) return false;
  return !has(ctx, attacker, 'Flying') || has(ctx, blocker, 'Flying') || has(ctx, blocker, 'Reach');
}

function declareAttackers(ctx: Ctx, attackers: ObjectId[], walkers: Record<ObjectId, ObjectId> = {}): void {
  const s = ctx.s;
  const pending = s.pending as Extract<PendingDecision, { kind: 'declareAttackers' }>;
  if (new Set(attackers).size !== attackers.length) fail('Duplicate attacker');
  for (const id of attackers) if (!pending.candidates.includes(id)) fail(`${id} cannot attack`);
  for (const [a, pw] of Object.entries(walkers)) {
    if (!attackers.includes(a) || !pending.planeswalkers.includes(pw)) fail(`${a} cannot attack ${pw}`);
  }
  const combat = s.combat ?? fail('No combat');
  for (const id of attackers) {
    if (!has(ctx, id, 'Vigilance')) tap(ctx, id); // 702.20b
    combat.attackers.push({ id, defending: other(s.turn.active), planeswalker: walkers[id] });
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
    const n = blocks.filter((b) => b.attacker === a).length;
    if (has(ctx, a, 'Menace') && n < 2) fail('A creature with menace must be blocked by two or more creatures');
    const max = Math.min(...auraStatics(s, ctx.reg, a).map((st) => st.maxBlockers ?? Infinity));
    if (n > max) fail(`That creature can't be blocked by more than ${String(max)} creature(s)`);
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
    // An attacker aimed at a planeswalker that left the battlefield deals no combat damage to anything (506.4c).
    if (a.planeswalker && !onBattlefield(s, a.planeswalker)) continue;
    const defender: Target = a.planeswalker ? { kind: 'object', id: a.planeswalker } : { kind: 'player', player: a.defending };
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
    combat: null, effects: [], pendingTriggers: [], resolving: null, delayedTriggers: [], priorityTo: null, pending: null, result: null,
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
  priority: ['pass', 'playLand', 'cast', 'activateMana', 'activate'],
  declareAttackers: ['declareAttackers'],
  declareBlockers: ['declareBlockers'],
  assignCombatDamage: ['assignCombatDamage'],
  discard: ['discard'],
  orderTriggers: ['orderTriggers'],
  chooseTargets: ['chooseTargets'],
  legendRule: ['legendRule'],
  searchLibrary: ['searchLibrary'],
  surveil: ['surveil'],
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
    case 'playLand': playLand(ctx, p, r.card, r.payLife); return;
    case 'cast': cast(ctx, p, r); return;
    case 'activateMana': activateMana(ctx, p, r.source, r.mana); afterAction(ctx, p); return;
    case 'activate': activate(ctx, p, r); return;
    case 'legendRule': {
      const d = pending as Extract<PendingDecision, { kind: 'legendRule' }>;
      if (!d.candidates.includes(r.keep)) fail('Choose one of the legendary permanents');
      for (const id of d.candidates) if (id !== r.keep) moveObject(ctx, id, 'graveyard');
      givePriority(ctx, s.priorityTo ?? s.turn.active);
      return;
    }
    case 'declareAttackers': declareAttackers(ctx, r.attackers, r.planeswalkerTargets); return;
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
    case 'surveil': {
      const d = pending as Extract<PendingDecision, { kind: 'surveil' }>;
      const all = [...r.graveyard, ...r.top];
      if (all.length !== d.cards.length || new Set(all).size !== all.length || !all.every((i) => Number.isInteger(i) && i >= 0 && i < d.cards.length)) fail('Put each surveilled card in the graveyard or back on top, once');
      const ids = s.zones.library[p].slice(0, d.cards.length);
      for (const i of r.graveyard) moveObject(ctx, ids[i] as ObjectId, 'graveyard');
      s.zones.library[p] = [...r.top.map((i) => ids[i] as ObjectId), ...s.zones.library[p].slice(d.cards.length - r.graveyard.length)];
      ctx.events.push({ kind: 'surveilled', player: p, toGraveyard: r.graveyard.length, toTop: r.top.length });
      if (continueResolution(ctx)) afterResolution(ctx);
      return;
    }
    case 'searchLibrary': {
      const d = pending as Extract<PendingDecision, { kind: 'searchLibrary' }>;
      if (r.card !== null && !d.cards.includes(r.card)) fail('That card is not one you can find');
      const res = s.resolving ?? fail('Nothing is resolving');
      const effect = res.effects[res.next - 1];
      if (effect?.kind !== 'searchBasicLand') return fail('No search is in progress');
      finishSearch(ctx, effect, p, r.card);
      if (continueResolution(ctx)) afterResolution(ctx);
      return;
    }
    case 'chooseTargets': {
      const d = pending as Extract<PendingDecision, { kind: 'chooseTargets' }>;
      if (r.targets.length !== d.targetOptions.length && !(d.optional && r.targets.length === 0)) fail(`Expected ${String(d.targetOptions.length)} target(s)`);
      r.targets.forEach((t, i) => { if (!(d.targetOptions[i] ?? []).some((o) => sameTarget(o, t))) fail(`Illegal target #${String(i + 1)}`); });
      stackTrigger(ctx, d.trigger, r.targets);
      givePriority(ctx, s.priorityTo ?? s.turn.active);
      return;
    }
  }
}
