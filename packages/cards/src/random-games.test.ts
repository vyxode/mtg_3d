import { describe, expect, it } from 'vitest';
import { createGame, eventsFor, nextInt, seedRng, step, viewFor, type GameEvent, type GameState, type ObjectId, type PlayerId, type PlayerInput, type Response, type RngState } from '@mtg3d/engine';
import { CARDS, DEFS } from './index';

/** A tiny random "player" that only uses the decision's own options; rejected moves fall back to passing. */
function randomResponse(s: GameState, rng: RngState): [Response, RngState] {
  let r = rng;
  const pick = (n: number): number => { const [x, next] = nextInt(r, n); r = next; return x; };
  const p = s.pending;
  if (!p) throw new Error('no decision');
  switch (p.kind) {
    case 'chooseStartingPlayer': return [{ kind: 'chooseStartingPlayer', first: pick(2) === 0 ? 'p1' : 'p2' }, r];
    case 'mulligan': return [p.mulligans < 2 && pick(5) === 0 ? { kind: 'mulligan' } : { kind: 'keep' }, r];
    case 'bottomCards': return [{ kind: 'bottomCards', cards: s.zones.hand[p.player].slice(0, p.count) }, r];
    case 'discard': return [{ kind: 'discard', cards: s.zones.hand[p.player].slice(0, p.count) }, r];
    case 'declareAttackers': return [{ kind: 'declareAttackers', attackers: p.candidates.filter(() => pick(2) === 0) }, r];
    case 'declareBlockers': {
      const blocks = p.candidates.filter(() => pick(2) === 0).map((c) => ({ blocker: c.blocker, attacker: c.attackers[pick(c.attackers.length)] as ObjectId }));
      return [{ kind: 'declareBlockers', blocks }, r];
    }
    case 'assignCombatDamage': return [{ kind: 'assignCombatDamage', assignment: { [p.blockers[0] as ObjectId]: p.amount } }, r];
    case 'orderTriggers': return [{ kind: 'orderTriggers', order: p.triggers.map((t) => t.id) }, r];
    case 'chooseTargets': return [{ kind: 'chooseTargets', targets: p.targetOptions.map((o) => o[pick(o.length)] as never) }, r];
    case 'priority': {
      if (p.legal.length === 0 || pick(10) < 4) return [{ kind: 'pass' }, r];
      const a = p.legal[pick(p.legal.length)];
      if (!a) return [{ kind: 'pass' }, r];
      if (a.kind === 'playLand') return [{ kind: 'playLand', card: a.card }, r];
      if (a.kind === 'activateMana') return [{ kind: 'activateMana', source: a.source }, r];
      const sources = p.legal.flatMap((l) => (l.kind === 'activateMana' ? [l.source] : []));
      return [{ kind: 'cast', card: a.card, targets: a.targetOptions.map((o) => o[pick(o.length)] as never), payment: sources }, r];
    }
  }
}

function randomDeck(rng: RngState): [string[], RngState] {
  let r = rng;
  const lands = DEFS.filter((d) => d.types.includes('Land')).map((d) => d.name);
  const spells = DEFS.filter((d) => !d.types.includes('Land')).map((d) => d.name);
  const deck: string[] = [];
  for (let i = 0; i < 40; i++) {
    const pool = i < 17 ? lands : spells;
    const [x, next] = nextInt(r, pool.length);
    r = next;
    deck.push(pool[x] as string);
  }
  return [deck, r];
}

function countOwned(s: GameState, p: PlayerId): number {
  return Object.values(s.objects).filter((o) => o.owner === p).length;
}

/** No id of a card hidden from `viewer` (opponent's hand, any library) may appear in what the viewer receives. */
function assertNoLeak(s: GameState, events: GameEvent[], viewer: PlayerId, seed: number): void {
  const opp: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
  const hidden = [...s.zones.hand[opp], ...s.zones.library.p1, ...s.zones.library.p2];
  const sent = JSON.stringify([viewFor(s, CARDS, viewer), eventsFor(events, viewer)]);
  for (const id of hidden) {
    if (sent.includes(`"${id}"`)) throw new Error(`Seed ${String(seed)}: ${viewer} can see hidden object ${id}`);
  }
  if (sent.includes('"rng"')) throw new Error('RNG state leaked');
}

function decksFor(seed: number): { p1: string[]; p2: string[]; rng: RngState } {
  const [p1, r1] = randomDeck(seedRng(seed));
  const [p2, rng] = randomDeck(r1);
  return { p1, p2, rng };
}

function playRandomGame(seed: number, maxInputs = 3000): { state: GameState; inputs: PlayerInput[] } {
  const decks = decksFor(seed);
  let rng = decks.rng;
  const created = createGame({ seed, decks: { p1: decks.p1, p2: decks.p2 } }, CARDS);
  if (!created.ok) throw new Error(created.error);
  let state = created.state;
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < maxInputs && !state.result; i++) {
    const p = state.pending;
    if (!p) throw new Error('Game neither over nor waiting for a decision');
    let response: Response;
    [response, rng] = randomResponse(state, rng);
    let input: PlayerInput = { player: p.player, decisionId: p.id, response };
    let r = step(state, input, CARDS);
    // A random choice may be illegal (could not pay, a lone blocker on a menace creature): fall back to a safe answer.
    const fallback: Response | null = p.kind === 'priority' ? { kind: 'pass' } : p.kind === 'declareBlockers' ? { kind: 'declareBlockers', blocks: [] } : null;
    if (!r.ok && fallback) {
      input = { player: p.player, decisionId: p.id, response: fallback };
      r = step(state, input, CARDS);
    }
    if (!r.ok) throw new Error(`Seed ${String(seed)}: rejected ${response.kind}: ${r.error}`);
    // Invariants after every input
    if (countOwned(r.state, 'p1') !== 40 || countOwned(r.state, 'p2') !== 40) throw new Error(`Seed ${String(seed)}: a card appeared or vanished`);
    for (const viewer of ['p1', 'p2'] as const) assertNoLeak(r.state, r.events, viewer, seed);
    inputs.push(input);
    state = r.state;
  }
  return { state, inputs };
}

describe('random games', () => {
  it('play hundreds of games without errors or lost cards', () => {
    let finished = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state } = playRandomGame(seed);
      if (state.result) finished++;
    }
    expect(finished).toBeGreaterThan(45); // most games end within the input budget
  }, 120_000);

  it('replaying the same inputs reproduces the exact same game', () => {
    const { state, inputs } = playRandomGame(4242);
    // Rebuild from scratch with the same decks, then re-apply the recorded inputs.
    const { p1, p2 } = decksFor(4242);
    const again = createGame({ seed: 4242, decks: { p1, p2 } }, CARDS);
    if (!again.ok) throw new Error(again.error);
    let replay = again.state;
    for (const input of inputs) {
      const r = step(replay, input, CARDS);
      if (!r.ok) throw new Error(r.error);
      replay = r.state;
    }
    expect(replay).toEqual(state);
  });
});
