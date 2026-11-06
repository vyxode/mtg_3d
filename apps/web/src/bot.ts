import { CARDS } from '@mtg3d/cards';
import type { CardDef, Effect, LegalAction, ObjectId, PendingDecision, PlayerId, PlayerView, Response, Target, VisibleObject } from '@mtg3d/engine';
import { autopay } from './autopay';

/**
 * The practice opponent: a rules-of-thumb player, not a trained model. It only ever answers with the options the
 * engine offers for its decision, so it can make weak plays but never illegal ones.
 */
export function botResponse(view: PlayerView): Response | null {
  const me = view.viewer;
  const raw = view.pending;
  if (!raw || raw.player !== me) return null;
  const d = raw as PendingDecision;
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';
  const obj = (id: ObjectId): VisibleObject | undefined => view.objects[id];
  const hand = view.zones.hand;

  switch (d.kind) {
    case 'chooseStartingPlayer': return { kind: 'chooseStartingPlayer', first: me };
    case 'mulligan': {
      const lands = hand.filter((id) => isLand(obj(id)?.card)).length;
      return lands >= 2 && lands <= 5 || d.mulligans >= 1 ? { kind: 'keep' } : { kind: 'mulligan' };
    }
    case 'bottomCards': return { kind: 'bottomCards', cards: worstFirst(view).slice(0, d.count) };
    case 'discard': return { kind: 'discard', cards: worstFirst(view).slice(0, d.count) };
    case 'orderTriggers': return { kind: 'orderTriggers', order: d.triggers.map((t) => t.id) };
    case 'legendRule': return { kind: 'legendRule', keep: d.candidates[0] as ObjectId };
    case 'searchLibrary': return { kind: 'searchLibrary', card: d.cards[0] ?? null };
    case 'surveil': return { kind: 'surveil', graveyard: [], top: d.cards.map((_, i) => i) };
    case 'chooseTargets': {
      const effects = CARDS.get(d.card)?.triggers?.find((t) => t.targets.length === d.targetOptions.length)?.effects ?? [];
      const targets = d.targetOptions.map((opts, i) => pickTarget(view, opts, roleOf(effects, i)));
      if (targets.some((t) => t === null)) return { kind: 'chooseTargets', targets: d.optional ? [] : d.targetOptions.map((o) => o[0] as Target) };
      return { kind: 'chooseTargets', targets: targets as Target[] };
    }
    case 'assignCombatDamage': {
      const out: Record<string, number> = {};
      let left = d.amount;
      for (const b of d.blockers) { const n = Math.min(left, d.lethal[b] ?? 0); out[b] = n; left -= n; }
      if (d.trample) out.player = left;
      else if (d.blockers[0]) out[d.blockers[0]] = (out[d.blockers[0]] ?? 0) + left;
      return { kind: 'assignCombatDamage', assignment: out };
    }
    case 'declareAttackers': {
      const blockers = creatures(view, opp).filter((b) => !b.tapped);
      const total = d.candidates.reduce((a, id) => a + (obj(id)?.power ?? 0), 0);
      if (blockers.length === 0 || total >= view.players[opp].life + blockers.reduce((a, b) => a + b.power, 0)) {
        return { kind: 'declareAttackers', attackers: d.candidates.filter((id) => (obj(id)?.power ?? 0) > 0) };
      }
      // Attack with a creature none of their untapped creatures can block and kill.
      const safe = d.candidates.filter((id) => { const c = obj(id); return c && c.power > 0 && blockers.every((b) => b.power < c.toughness); });
      return { kind: 'declareAttackers', attackers: safe };
    }
    case 'declareBlockers': {
      const attackers = [...new Set(d.candidates.flatMap((c) => c.attackers))].map(obj).filter((o): o is VisibleObject => !!o).sort((a, b) => b.power - a.power);
      const incoming = attackers.reduce((a, o) => a + o.power, 0);
      const lethal = incoming >= view.players[me].life;
      const used = new Set<ObjectId>();
      const blocks: { blocker: ObjectId; attacker: ObjectId }[] = [];
      for (const a of attackers) {
        if (CARDS.get(a.card)?.keywords?.includes('Menace')) continue; // would need two blockers: shortcut, it takes the hit
        const can = d.candidates.filter((c) => !used.has(c.blocker) && c.attackers.includes(a.id)).map((c) => obj(c.blocker)).filter((o): o is VisibleObject => !!o);
        // Best: survives and kills; then survives; then trades evenly; when the hit would kill us, anything.
        const pick = can.find((b) => b.toughness > a.power && b.power >= a.toughness)
          ?? can.find((b) => b.toughness > a.power)
          ?? can.find((b) => b.power >= a.toughness && value(b) <= value(a))
          ?? (lethal ? can.sort((x, y) => value(x) - value(y))[0] : undefined);
        if (pick) { used.add(pick.id); blocks.push({ blocker: pick.id, attacker: a.id }); }
      }
      return { kind: 'declareBlockers', blocks };
    }
    case 'priority': return priority(view, d.legal);
  }
}

/** Plays at its own main phases with an empty stack: a land, then the biggest spell it can afford and aim well. */
function priority(view: PlayerView, legal: LegalAction[]): Response {
  const me = view.viewer;
  const pass: Response = { kind: 'pass' };
  const step = view.turn.step;
  if (view.turn.active !== me || view.stack.length > 0 || (step !== 'main1' && step !== 'main2')) return pass;
  const land = legal.find((a) => a.kind === 'playLand');
  if (land?.kind === 'playLand') return { kind: 'playLand', card: land.card, payLife: false };

  const sources = legal.flatMap((l) => (l.kind === 'activateMana' ? [l.source] : []));
  let best: { score: number; r: Response } | null = null;
  for (const a of legal) {
    if (a.kind !== 'cast' && a.kind !== 'activate') continue;
    const name = view.objects[a.kind === 'cast' ? a.card : a.source]?.card ?? '';
    const def = CARDS.get(name);
    if (!def) continue;
    const ability = a.kind === 'activate' ? def.activated?.[a.ability] : undefined;
    if (a.kind === 'activate' && (!ability || ability.cost.crew !== undefined)) continue;
    const effects: readonly Effect[] = (a.kind === 'cast' ? def.spell?.effects : ability?.effects) ?? [];
    const targets = a.targetOptions.map((opts, i) => pickTarget(view, opts, def.enchant && a.kind === 'cast' ? 'help' : roleOf(effects, i)));
    if (targets.some((t) => t === null)) continue; // nothing sensible to aim at
    const payment = a.kind === 'cast'
      ? autopay(view, CARDS, sources, a.cost)
      : autopay(view, CARDS, ability?.cost.tap ? sources.filter((x) => x !== a.source) : sources, ability?.cost.mana ?? null);
    if (!payment) continue;
    const score = a.kind === 'cast' ? 10 * cmc(def) + (def.types.includes('Creature') ? 5 : 0) : 1;
    if (a.kind === 'activate' && ability?.cost.sacrifice) continue; // never throws its own permanents away
    const r: Response = a.kind === 'cast'
      ? { kind: 'cast', card: a.card, targets: targets as Target[], payment, warp: a.warp === true, flashback: a.flashback === true }
      : { kind: 'activate', source: a.source, ability: a.ability, targets: targets as Target[], payment };
    if (!best || score > best.score) best = { score, r };
  }
  return best?.r ?? pass;
}

type Role = 'harm' | 'help';
/** Whether the effects aimed at target `i` hurt it (damage, destroy…) or help it (pump, counters…). */
function roleOf(effects: readonly Effect[], i: number): Role {
  for (const e of effects) {
    if (!('target' in e) || e.target !== i) continue;
    if (e.kind === 'pump') return e.power >= 0 ? 'help' : 'harm';
    if (e.kind === 'grant' || e.kind === 'addCounters' || e.kind === 'targetDraws') return 'help';
    return 'harm';
  }
  return 'harm';
}

/** The best target for a role: their biggest thing (or them) to harm, our biggest creature (or us) to help. */
function pickTarget(view: PlayerView, opts: Target[], role: Role): Target | null {
  const me = view.viewer;
  const mine = (t: Target) => (t.kind === 'player' ? t.player === me : view.objects[t.id]?.controller === me);
  const worth = (t: Target) => (t.kind === 'player' ? 0.5 : value(view.objects[t.id]));
  const pool = opts.filter((t) => (role === 'harm' ? !mine(t) : mine(t)));
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => worth(b) - worth(a))[0] ?? null;
}

const isLand = (name: string | undefined) => !!name && CARDS.get(name)?.types.includes('Land') === true;
const cmc = (def: CardDef | undefined) => { const c = def?.manaCost; return c ? c.generic + (['W', 'U', 'B', 'R', 'G', 'C'] as const).reduce((a, k) => a + (c[k] ?? 0), 0) : 0; };
const value = (o: VisibleObject | undefined) => (o ? (o.types.includes('Creature') ? o.power + o.toughness : 0) + cmc(CARDS.get(o.card)) : 0);
const creatures = (view: PlayerView, p: PlayerId) => view.zones.battlefield.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.controller === p && o.types.includes('Creature'));

/** Cards to put away first: extra lands when there are plenty, otherwise the most expensive spells. */
function worstFirst(view: PlayerView): ObjectId[] {
  const hand = view.zones.hand;
  const lands = hand.filter((id) => isLand(view.objects[id]?.card));
  const cost = (id: ObjectId) => cmc(CARDS.get(view.objects[id]?.card ?? ''));
  const spells = hand.filter((id) => !lands.includes(id)).sort((a, b) => cost(b) - cost(a));
  return lands.length > 3 ? [...lands, ...spells] : [...spells, ...lands];
}
