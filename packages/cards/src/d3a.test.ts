import { describe, expect, it } from 'vitest';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const obj = (id: string) => ({ kind: 'object', id }) as const;
const resolve = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });
const cardsIn = (d: Driver, p: 'p1' | 'p2', zone: 'graveyard' | 'library' | 'exile') =>
  (zone === 'exile' ? d.state.zones.exile : d.state.zones[zone][p]).map((id) => d.state.objects[id]?.card);

describe('library searches (701.23)', () => {
  it('Fabled Passage: sacrifice, find a basic land tapped, shuffle; it untaps with four or more lands', () => {
    const d = start({ p1: { battlefield: ['Fabled Passage', 'Forest', 'Forest', 'Forest'], library: ['Grizzly Bears', 'Mountain', 'Forest'] } });
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Fabled Passage'), ability: 0, targets: [], payment: [] });
    expect(cardsIn(d, 'p1', 'graveyard')).toEqual(['Fabled Passage']); // sacrificed as a cost
    resolve(d);
    const search = d.pending('searchLibrary');
    expect([...search.cards].sort()).toEqual(['Forest', 'Mountain']); // basic lands only
    d.do({ kind: 'searchLibrary', card: 'Mountain' });
    const mountain = d.id('p1', 'battlefield', 'Mountain');
    expect(d.state.objects[mountain]?.tapped).toBe(false); // Forest ×3 + Mountain = 4 lands
    expect(d.events.some((e) => e.kind === 'shuffled' && e.player === 'p1')).toBe(true);
    expect(d.pending('priority').player).toBe('p1');
  });

  it('with fewer than four lands the found land stays tapped; finding nothing still shuffles', () => {
    const d = start({ p1: { battlefield: ['Fabled Passage', 'Forest'], library: ['Forest'] } });
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Fabled Passage'), ability: 0, targets: [], payment: [] });
    resolve(d);
    d.do({ kind: 'searchLibrary', card: 'Forest' });
    expect(d.ids('p1', 'battlefield', 'Forest').map((id) => d.state.objects[id]?.tapped)).toEqual([false, true]);

    const none = start({ p1: { hand: ['Shared Roots'], battlefield: ['Forest', 'Forest'], library: ['Forest'] } });
    none.do({ kind: 'cast', card: none.id('p1', 'hand', 'Shared Roots'), targets: [], payment: none.ids('p1', 'battlefield', 'Forest') });
    resolve(none);
    none.do({ kind: 'searchLibrary', card: null });
    expect(cardsIn(none, 'p1', 'library')).toEqual(['Forest']);
    expect(cardsIn(none, 'p1', 'graveyard')).toEqual(['Shared Roots']);
    expect(none.events.filter((e) => e.kind === 'shuffled')).toHaveLength(1);
  });

  it('a library without basic lands asks nothing and the spell finishes resolving', () => {
    const d = start({ p1: { hand: ['Shared Roots'], battlefield: ['Forest', 'Forest'], library: ['Grizzly Bears'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shared Roots'), targets: [], payment: d.ids('p1', 'battlefield', 'Forest') });
    resolve(d);
    expect(d.pending('priority').player).toBe('p1');
    expect(cardsIn(d, 'p1', 'graveyard')).toEqual(['Shared Roots']);
  });

  it('only the searching player may answer, and only with a card that was offered', () => {
    const d = start({ p1: { hand: ['Shared Roots'], battlefield: ['Forest', 'Forest'], library: ['Forest', 'Grizzly Bears'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shared Roots'), targets: [], payment: d.ids('p1', 'battlefield', 'Forest') });
    resolve(d);
    expect(d.reject({ kind: 'searchLibrary', card: 'Grizzly Bears' })).toMatch(/not one you can find/);
  });
});

describe('Escape Tunnel', () => {
  it('makes a creature with power 2 or less unblockable this turn', () => {
    const d = start({ p1: { battlefield: ['Escape Tunnel', 'Grizzly Bears', 'Hill Giant'] }, p2: { battlefield: ['Wall of Stone'] } });
    const bear = d.id('p1', 'battlefield', 'Grizzly Bears');
    const giant = d.id('p1', 'battlefield', 'Hill Giant');
    expect(d.reject({ kind: 'activate', source: d.id('p1', 'battlefield', 'Escape Tunnel'), ability: 1, targets: [obj(giant)], payment: [] })).toMatch(/Illegal target/);
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Escape Tunnel'), ability: 1, targets: [obj(bear)], payment: [] });
    resolve(d);
    resolve(d); // main 1 → beginning of combat → declare attackers
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    d.do({ kind: 'declareAttackers', attackers: [bear, giant] });
    resolve(d);
    const blocks = d.pending('declareBlockers');
    expect(blocks.candidates[0]?.attackers).toEqual([giant]);
  });
});

describe('landfall', () => {
  it("Sazh's Chocobo and Mossborn Hydra grow when a land you control enters, not when the opponent's does", () => {
    const d = start({ p1: { hand: ['Forest'], battlefield: ["Sazh's Chocobo", 'Mossborn Hydra'] }, p2: { battlefield: ["Sazh's Chocobo"] } });
    const bird = d.id('p1', 'battlefield', "Sazh's Chocobo");
    const hydra = d.id('p1', 'battlefield', 'Mossborn Hydra');
    expect(d.power(hydra)).toBe(1); // enters with a +1/+1 counter
    d.do({ kind: 'playLand', card: d.id('p1', 'hand', 'Forest') });
    d.do({ kind: 'orderTriggers', order: d.pending('orderTriggers').triggers.map((t) => t.id) });
    resolve(d);
    resolve(d);
    expect(d.power(bird)).toBe(1);
    expect(d.power(hydra)).toBe(2);
    expect(d.power(d.id('p2', 'battlefield', "Sazh's Chocobo"))).toBe(0);
  });

  it('Mossborn Hydra doubles its counters on each landfall: 1 → 2 → 4', () => {
    const d = start({ p1: { battlefield: ['Mossborn Hydra', 'Fabled Passage'], hand: ['Forest'], library: ['Forest'] } });
    const hydra = d.id('p1', 'battlefield', 'Mossborn Hydra');
    d.do({ kind: 'playLand', card: d.id('p1', 'hand', 'Forest') });
    resolve(d);
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Fabled Passage'), ability: 0, targets: [], payment: [] });
    resolve(d);
    d.do({ kind: 'searchLibrary', card: 'Forest' });
    resolve(d);
    expect(d.power(hydra)).toBe(4);
    expect(d.toughness(hydra)).toBe(4);
  });

  it('Icetill Explorer: two land drops, lands from the graveyard, and it mills you on landfall', () => {
    const d = start({ p1: { battlefield: ['Icetill Explorer'], hand: ['Forest', 'Forest', 'Forest'], graveyard: ['Mountain'], library: ['Grizzly Bears', 'Island'] } });
    d.do({ kind: 'playLand', card: d.ids('p1', 'hand', 'Forest')[0] as string });
    resolve(d);
    expect(cardsIn(d, 'p1', 'graveyard')).toEqual(['Mountain', 'Grizzly Bears']);
    const legal = d.pending('priority').legal;
    expect(legal.some((a) => a.kind === 'playLand' && d.state.objects[a.card]?.zone === 'graveyard')).toBe(true);
    d.do({ kind: 'playLand', card: d.id('p1', 'graveyard', 'Mountain') });
    resolve(d);
    expect(d.ids('p1', 'battlefield', 'Mountain')).toHaveLength(1);
    expect(d.reject({ kind: 'playLand', card: d.ids('p1', 'hand', 'Forest')[0] as string })).toMatch(/already played/);
  });

  it('Sapling Nursery: affinity for Forests, a 3/4 reach Treefolk per land, and indestructible for Treefolk and Forests', () => {
    const forests = Array<string>(6).fill('Forest');
    const d = start({ p1: { hand: ['Sapling Nursery', 'Forest'], battlefield: forests }, p2: { hand: ['Murder'], battlefield: ['Swamp', 'Swamp', 'Swamp'] } });
    const [f1, f2] = d.ids('p1', 'battlefield', 'Forest') as [string, string];
    d.do({ kind: 'activateMana', source: f1 }); // any action recomputes the legal actions
    const cast = d.pending('priority').legal.find((a) => a.kind === 'cast');
    expect(cast?.kind === 'cast' && cast.cost).toEqual({ generic: 0, G: 2 }); // {6}{G}{G} minus six Forests
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Sapling Nursery'), targets: [], payment: [f2] });
    resolve(d);
    d.do({ kind: 'playLand', card: d.id('p1', 'hand', 'Forest') });
    resolve(d);
    const tree = d.id('p1', 'battlefield', 'Treefolk');
    expect([d.power(tree), d.toughness(tree)]).toEqual([3, 4]);
    expect(d.reject({ kind: 'activate', source: d.id('p1', 'battlefield', 'Sapling Nursery'), ability: 0, targets: [], payment: [d.id('p1', 'battlefield', 'Sapling Nursery')] })).toMatch(/cannot also pay/);
    const untapped = d.ids('p1', 'battlefield', 'Forest').filter((id) => !d.state.objects[id]?.tapped).slice(0, 2);
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Sapling Nursery'), ability: 0, targets: [], payment: untapped });
    expect(cardsIn(d, 'p1', 'exile')).toEqual(['Sapling Nursery']);
    resolve(d);
    d.do({ kind: 'pass' }); // p1 passes in main 1 with an empty stack: p2 gets priority
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Murder'), targets: [obj(tree)], payment: d.ids('p2', 'battlefield', 'Swamp') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.ids('p1', 'battlefield', 'Treefolk')).toEqual([tree]); // indestructible until end of turn
  });
});
