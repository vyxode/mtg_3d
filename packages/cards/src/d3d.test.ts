import { describe, expect, it } from 'vitest';
import type { GameState } from '@mtg3d/engine';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const resolve = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });
const names = (d: Driver, ids: string[]) => ids.map((id) => d.state.objects[id]?.card);

function until(d: Driver, done: (s: GameState) => boolean): Driver {
  for (let i = 0; i < 300 && !done(d.state) && d.state.pending; i++) {
    const p = d.pending();
    if (p.kind === 'declareAttackers') d.do({ kind: 'declareAttackers', attackers: [] });
    else if (p.kind === 'declareBlockers') d.do({ kind: 'declareBlockers', blocks: [] });
    else d.do({ kind: 'pass' });
  }
  if (!done(d.state)) throw new Error(`condition never reached: ${JSON.stringify({ turn: d.state.turn, result: d.state.result, stack: d.state.stack.map((e) => e.card) })}`);
  return d;
}
const chapterOnStack = (turn: number) => (s: GameState) => s.turn.number === turn && s.turn.step === 'main1' && s.stack.length > 0;

describe('Esper Origins // Summon: Esper Maduin', () => {
  it('from the hand: surveil 2 and gain 2 life, then to the graveyard', () => {
    const d = start({ p1: { hand: ['Esper Origins'], battlefield: ['Forest', 'Forest'], library: ['Lightning Bolt', 'Grizzly Bears', 'Forest'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Esper Origins'), targets: [], payment: d.ids('p1', 'battlefield', 'Forest') });
    resolve(d);
    expect(d.pending('surveil').cards).toEqual(['Lightning Bolt', 'Grizzly Bears']);
    expect(d.reject({ kind: 'surveil', graveyard: [0], top: [0] })).toMatch(/once/);
    d.do({ kind: 'surveil', graveyard: [0], top: [1] });
    expect(names(d, d.state.zones.library.p1)).toEqual(['Grizzly Bears', 'Forest']);
    expect(names(d, d.state.zones.graveyard.p1)).toEqual(['Lightning Bolt', 'Esper Origins']);
    expect(d.state.players.p1.life).toBe(22);
  });

  it('with flashback it becomes the Saga, whose three chapters run on later turns; finality exiles it', () => {
    const forests = Array<string>(4).fill('Forest');
    const d = start({
      p1: { graveyard: ['Esper Origins'], battlefield: [...forests, 'Grizzly Bears'], library: ['Grizzly Bears', 'Forest', 'Forest', 'Forest', 'Forest'] },
      p2: { library: ['Forest', 'Forest', 'Forest', 'Forest'] },
    });
    const bear = d.id('p1', 'battlefield', 'Grizzly Bears');
    const legal = (s: GameState) => s.pending?.kind === 'priority' ? s.pending.legal : [];
    d.do({ kind: 'activateMana', source: d.ids('p1', 'battlefield', 'Forest')[0] as string });
    expect(legal(d.state)).toContainEqual(expect.objectContaining({ kind: 'cast', flashback: true, cost: { generic: 3, G: 1 } }));
    d.do({ kind: 'cast', card: d.id('p1', 'graveyard', 'Esper Origins'), targets: [], payment: d.ids('p1', 'battlefield', 'Forest').slice(1), flashback: true });
    resolve(d);
    d.do({ kind: 'surveil', graveyard: [], top: [0, 1] });
    const saga = d.id('p1', 'battlefield', 'Summon: Esper Maduin');
    expect(d.state.objects[saga]?.kindCounters).toEqual({ finality: 1, lore: 1 });
    expect([d.power(saga), d.toughness(saga)]).toEqual([4, 4]);
    resolve(d); // chapter I: reveal Grizzly Bears, a permanent card: to the hand
    expect(names(d, d.state.zones.hand.p1)).toEqual(['Grizzly Bears']);

    until(d, chapterOnStack(5));
    resolve(d); // chapter II
    expect(d.state.players.p1.manaPool.G).toBe(2);

    until(d, chapterOnStack(7));
    resolve(d); // chapter III, then the Saga is sacrificed (714.4) and its finality counter exiles it
    expect([d.power(bear), d.toughness(bear)]).toEqual([4, 4]);
    expect(d.state.effects).toContainEqual(expect.objectContaining({ affected: bear, grant: 'Trample' }));
    expect(names(d, d.state.zones.exile)).toEqual(['Esper Origins']);
    expect(d.ids('p1', 'graveyard', 'Esper Origins')).toEqual([]);
  });
});

describe('Lumbering Worldwagon', () => {
  it('has power equal to your lands, crews with power 4, and searches when it attacks', () => {
    const d = start({ p1: { battlefield: ['Lumbering Worldwagon', 'Forest', 'Forest', 'Forest', 'Grizzly Bears', 'Hill Giant'], library: ['Forest', 'Forest'] }, p2: { library: ['Forest'] } });
    const wagon = d.id('p1', 'battlefield', 'Lumbering Worldwagon');
    const bear = d.id('p1', 'battlefield', 'Grizzly Bears');
    const giant = d.id('p1', 'battlefield', 'Hill Giant');
    expect([d.power(wagon), d.toughness(wagon)]).toEqual([3, 4]);
    expect(d.reject({ kind: 'activate', source: wagon, ability: 0, targets: [], payment: [], crew: [bear] })).toMatch(/total power 4/);
    d.do({ kind: 'activate', source: wagon, ability: 0, targets: [], payment: [], crew: [bear, giant] });
    expect([d.state.objects[bear]?.tapped, d.state.objects[giant]?.tapped]).toEqual([true, true]);
    resolve(d);
    resolve(d); // main 1 → beginning of combat → declare attackers
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    d.do({ kind: 'declareAttackers', attackers: [wagon] });
    resolve(d);
    d.do({ kind: 'searchLibrary', card: 'Forest' });
    expect(d.power(wagon)).toBe(4);
    until(d, (s) => s.turn.number === 4);
    expect(d.state.players.p2.life).toBe(16);
    expect(d.pending().kind).toBeDefined();
    expect(d.state.effects.filter((e) => e.affected === wagon)).toEqual([]); // no longer a creature
  });
});
