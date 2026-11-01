import { describe, expect, it } from 'vitest';
import type { GameState, Step } from '@mtg3d/engine';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const obj = (id: string) => ({ kind: 'object', id }) as const;
const resolve = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });

/** Passes (and declares no attackers or blockers) until `done` holds. */
function until(d: Driver, done: (s: GameState) => boolean): Driver {
  for (let i = 0; i < 200 && !done(d.state); i++) {
    const p = d.pending();
    if (p.kind === 'declareAttackers') d.do({ kind: 'declareAttackers', attackers: [] });
    else if (p.kind === 'declareBlockers') d.do({ kind: 'declareBlockers', blocks: [] });
    else d.do({ kind: 'pass' });
  }
  if (!done(d.state)) throw new Error('condition never reached');
  return d;
}
const at = (turn: number, step: Step, player: 'p1' | 'p2') => (s: GameState) =>
  s.turn.number === turn && s.turn.step === step && s.pending?.kind === 'priority' && s.pending.player === player && s.stack.length === 0;

describe('warp (702.185)', () => {
  it('cast for its warp cost, exiled at the next end step, cast from exile on a later turn', () => {
    const forests = Array<string>(4).fill('Forest');
    const d = start({ p1: { hand: ['Mightform Harmonizer'], battlefield: forests, library: ['Forest', 'Forest'] }, p2: { library: ['Forest', 'Forest'] } });
    const card = d.id('p1', 'hand', 'Mightform Harmonizer');
    d.do({ kind: 'cast', card, targets: [], payment: d.ids('p1', 'battlefield', 'Forest').slice(0, 3), warp: true });
    resolve(d);
    expect(d.ids('p1', 'battlefield', 'Mightform Harmonizer')).toHaveLength(1);

    until(d, (s) => s.turn.step === 'end' && s.stack.length > 0); // the delayed trigger is on the stack
    resolve(d);
    const exiled = d.state.zones.exile.find((id) => d.state.objects[id]?.card === 'Mightform Harmonizer') as string;
    expect(exiled).toBeDefined();
    expect(d.reject({ kind: 'cast', card: exiled, targets: [], payment: [] })).toMatch(/cannot cast that card/);

    until(d, at(5, 'main1', 'p1')); // p1's next turn
    const legal = d.pending('priority').legal.find((a) => a.kind === 'cast' && a.card === exiled);
    expect(legal?.kind === 'cast' && legal.cost).toEqual({ generic: 2, G: 2 }); // its normal cost, not warp
    d.do({ kind: 'cast', card: exiled, targets: [], payment: d.ids('p1', 'battlefield', 'Forest') });
    resolve(d);
    until(d, (s) => s.turn.number === 6);
    expect(d.ids('p1', 'battlefield', 'Mightform Harmonizer')).toHaveLength(1); // cast normally: it stays
  });

  it("landfall doubles a creature's power until end of turn", () => {
    const d = start({ p1: { hand: ['Forest'], battlefield: ['Mightform Harmonizer'] } });
    const m = d.id('p1', 'battlefield', 'Mightform Harmonizer');
    d.do({ kind: 'playLand', card: d.id('p1', 'hand', 'Forest') });
    resolve(d);
    expect(d.power(m)).toBe(8);
    until(d, (s) => s.turn.number === 4);
    expect(d.power(m)).toBe(4);
  });
});

describe('earthbend', () => {
  it('Ba Sing Se animates a land with haste and counters; when it dies it returns tapped as a plain land', () => {
    const d = start({ p1: { battlefield: ['Ba Sing Se', 'Forest', 'Forest', 'Forest', 'Forest'] }, p2: { hand: ['Lightning Bolt'], battlefield: ['Mountain'] } });
    const [target, ...payers] = d.ids('p1', 'battlefield', 'Forest') as [string, string, string, string];
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Ba Sing Se'), ability: 0, targets: [obj(target)], payment: payers });
    resolve(d);
    expect([d.power(target), d.toughness(target)]).toEqual([2, 2]);
    expect(d.pending('priority').legal).toContainEqual({ kind: 'activateMana', source: target }); // haste: still taps for mana

    d.do({ kind: 'pass' });
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Lightning Bolt'), targets: [obj(target)], payment: [d.id('p2', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }); // Bolt resolves: the land dies, its return trigger goes on the stack
    resolve(d);
    const back = d.ids('p1', 'battlefield', 'Forest').find((id) => !payers.includes(id)) as string;
    expect(d.state.objects[back]?.tapped).toBe(true);
    expect(d.pending('priority').legal.some((a) => a.kind === 'activateMana' && a.source === back)).toBe(false);
    expect(d.state.effects).toEqual([]);
  });

  it('Ba Sing Se enters tapped without a basic land and its ability is sorcery-speed', () => {
    const d = start({ p1: { hand: ['Ba Sing Se'] } });
    d.do({ kind: 'playLand', card: d.id('p1', 'hand', 'Ba Sing Se') });
    expect(d.state.objects[d.id('p1', 'battlefield', 'Ba Sing Se')]?.tapped).toBe(true);
    const e = start({ p1: { hand: ['Ba Sing Se'], battlefield: ['Forest'] } });
    e.do({ kind: 'playLand', card: e.id('p1', 'hand', 'Ba Sing Se') });
    expect(e.state.objects[e.id('p1', 'battlefield', 'Ba Sing Se')]?.tapped).toBe(false);

    const u = start({ step: 'upkeep', p1: { battlefield: ['Ba Sing Se', 'Forest', 'Forest'] } });
    expect(u.reject({ kind: 'activate', source: u.id('p1', 'battlefield', 'Ba Sing Se'), ability: 0, targets: [obj(u.id('p1', 'battlefield', 'Ba Sing Se'))], payment: u.ids('p1', 'battlefield', 'Forest') })).toMatch(/as a sorcery/);
  });

  it('Earthbender Ascension: earthbend 2 and search on entering; the fourth quest counter pumps a creature', () => {
    const d = start({ p1: { hand: ['Earthbender Ascension'], battlefield: ['Forest', 'Forest', 'Forest'], library: ['Forest'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Earthbender Ascension'), targets: [], payment: d.ids('p1', 'battlefield', 'Forest') });
    resolve(d);
    const choose = d.pending('chooseTargets');
    const land = choose.targetOptions[0]?.[0];
    if (land?.kind !== 'object') throw new Error('expected a land target');
    d.do({ kind: 'chooseTargets', targets: [land] });
    resolve(d);
    d.do({ kind: 'searchLibrary', card: 'Forest' }); // the found land is a landfall: one quest counter
    resolve(d);
    const asc = d.id('p1', 'battlefield', 'Earthbender Ascension');
    expect(d.power(land.id)).toBe(2);
    expect(d.state.objects[asc]?.kindCounters).toEqual({ quest: 1 });

    const e = start({ p1: { hand: ['Forest', 'Forest'], battlefield: ['Earthbender Ascension', 'Grizzly Bears', 'Icetill Explorer'] } });
    const bear = e.id('p1', 'battlefield', 'Grizzly Bears');
    (e.state.objects[e.id('p1', 'battlefield', 'Earthbender Ascension')] as GameState['objects'][string]).kindCounters = { quest: 2 };
    e.do({ kind: 'playLand', card: e.ids('p1', 'hand', 'Forest')[0] as string });
    e.do({ kind: 'orderTriggers', order: e.pending('orderTriggers').triggers.map((t) => t.id) });
    resolve(e);
    resolve(e); // 3 quest counters: no reflexive trigger
    expect(e.state.stack).toEqual([]);
    e.do({ kind: 'playLand', card: e.ids('p1', 'hand', 'Forest')[0] as string });
    e.do({ kind: 'orderTriggers', order: e.pending('orderTriggers').triggers.map((t) => t.id) });
    resolve(e);
    const reflexive = e.pending();
    if (reflexive.kind === 'chooseTargets') e.do({ kind: 'chooseTargets', targets: [obj(bear)] });
    resolve(e);
    resolve(e);
    expect(e.power(bear)).toBe(3);
    expect(e.state.effects).toContainEqual(expect.objectContaining({ layer: '6', affected: bear, grant: 'Trample' }));
  });
});

describe('Surrak, Elusive Hunter', () => {
  it("draws when the opponent targets your creature, not when you do, and can't be countered", () => {
    const d = start({
      p1: { hand: ['Giant Growth', 'Surrak, Elusive Hunter'], battlefield: ['Surrak, Elusive Hunter', 'Forest', 'Forest', 'Forest', 'Forest'], library: ['Forest', 'Forest'] },
      p2: { hand: ['Shock', 'Counterspell'], battlefield: ['Mountain', 'Island', 'Island'] },
    });
    const surrak = d.id('p1', 'battlefield', 'Surrak, Elusive Hunter');
    const [f1, f2, f3, f4] = d.ids('p1', 'battlefield', 'Forest') as [string, string, string, string];
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Giant Growth'), targets: [obj(surrak)], payment: [f1] });
    expect(d.state.stack).toHaveLength(1); // no trigger for your own spell
    d.do({ kind: 'pass' });
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Shock'), targets: [obj(surrak)], payment: [d.id('p2', 'battlefield', 'Mountain')] });
    expect(d.state.stack.map((e) => e.card)).toEqual(['Giant Growth', 'Shock', 'Surrak, Elusive Hunter']);
    const hand = d.state.zones.hand.p1.length;
    resolve(d);
    expect(d.state.zones.hand.p1.length).toBe(hand + 1);

    until(d, (s) => s.stack.length === 0 && s.pending?.kind === 'priority' && s.pending.player === 'p1');
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Surrak, Elusive Hunter'), targets: [], payment: [f2, f3, f4] });
    const spell = d.state.stack[0]?.id as string;
    d.do({ kind: 'pass' });
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Counterspell'), targets: [obj(spell)], payment: d.ids('p2', 'battlefield', 'Island') });
    resolve(d); // the "becomes the target" trigger of the Surrak in play
    resolve(d); // Counterspell resolves and does nothing
    resolve(d); // Surrak resolves
    expect(d.ids('p1', 'battlefield', 'Surrak, Elusive Hunter')).toHaveLength(2);
  });
});
