import { describe, expect, it } from 'vitest';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const obj = (id: string) => ({ kind: 'object', id }) as const;
const P2 = { kind: 'player', player: 'p2' } as const;
const resolve = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });

describe('static abilities', () => {
  it('Glorious Anthem pumps only your creatures, while it is on the battlefield', () => {
    const d = start({ p1: { battlefield: ['Glorious Anthem', 'Grizzly Bears'] }, p2: { battlefield: ['Grizzly Bears'] } });
    expect(d.power(d.id('p1', 'battlefield', 'Grizzly Bears'))).toBe(3);
    expect(d.power(d.id('p2', 'battlefield', 'Grizzly Bears'))).toBe(2);
  });

  it('Benalish Marshal pumps the others but not itself', () => {
    const d = start({ p1: { battlefield: ['Benalish Marshal', 'Savannah Lions'] } });
    expect(d.power(d.id('p1', 'battlefield', 'Benalish Marshal'))).toBe(3);
    expect(d.toughness(d.id('p1', 'battlefield', 'Savannah Lions'))).toBe(2);
  });
});

describe('activated abilities (602)', () => {
  it('a {T} ability uses the stack and needs the creature to have been under control since the turn began', () => {
    const sick = start({ p1: { battlefield: [{ card: 'Prodigal Pyromancer', sick: true }] } });
    const pyro = sick.id('p1', 'battlefield', 'Prodigal Pyromancer');
    expect(sick.reject({ kind: 'activate', source: pyro, ability: 0, targets: [P2], payment: [] })).toMatch(/cannot be tapped/);

    const d = start({ p1: { battlefield: ['Prodigal Pyromancer'] } });
    const p = d.id('p1', 'battlefield', 'Prodigal Pyromancer');
    expect(d.state.pending).toBeTruthy();
    d.do({ kind: 'activate', source: p, ability: 0, targets: [P2], payment: [] });
    expect(d.state.objects[p]?.tapped).toBe(true);
    expect(d.state.stack).toMatchObject([{ kind: 'ability', card: 'Prodigal Pyromancer' }]);
    resolve(d);
    expect(d.state.players.p2.life).toBe(19);
  });
});

describe('tokens, counters and destroy', () => {
  it('Raise the Alarm creates two tokens, and a token that dies ceases to exist (704.5d)', () => {
    const d = start({ p1: { hand: ['Raise the Alarm', 'Shock'], battlefield: ['Plains', 'Plains', 'Mountain'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Raise the Alarm'), targets: [], payment: d.ids('p1', 'battlefield', 'Plains') });
    resolve(d);
    const soldiers = d.ids('p1', 'battlefield', 'Soldier');
    expect(soldiers).toHaveLength(2);
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shock'), targets: [obj(soldiers[0] as string)], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    resolve(d);
    expect(d.ids('p1', 'battlefield', 'Soldier')).toHaveLength(1);
    expect(d.state.zones.graveyard.p1.map((id) => d.state.objects[id]?.card)).not.toContain('Soldier');
    expect(Object.values(d.state.objects).filter((o) => o.card === 'Soldier')).toHaveLength(1);
  });

  it("Ajani's Pridemate gets a +1/+1 counter whenever you gain life", () => {
    const d = start({ p1: { hand: ['Inspiring Overseer'], battlefield: ["Ajani's Pridemate", 'Plains', 'Plains', 'Plains'], library: ['Plains'] } });
    const cat = d.id('p1', 'battlefield', "Ajani's Pridemate");
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Inspiring Overseer'), targets: [], payment: d.ids('p1', 'battlefield', 'Plains') });
    resolve(d); // Overseer enters, its trigger goes on the stack
    resolve(d); // gain 1 life: Pridemate triggers
    resolve(d); // counter
    expect(d.state.objects[cat]?.counters).toBe(1);
    expect(d.power(cat)).toBe(3);
  });

  it('Murder destroys a creature but not an indestructible one (701.8)', () => {
    const d = start({ p1: { hand: ['Murder', 'Murder'], battlefield: Array<string>(6).fill('Swamp') }, p2: { battlefield: ['Grizzly Bears', 'Darksteel Myr'] } });
    const [m1, m2] = d.ids('p1', 'hand', 'Murder') as [string, string];
    const swamps = d.ids('p1', 'battlefield', 'Swamp');
    d.do({ kind: 'cast', card: m1, targets: [obj(d.id('p2', 'battlefield', 'Grizzly Bears'))], payment: swamps.slice(0, 3) });
    resolve(d);
    d.do({ kind: 'cast', card: m2, targets: [obj(d.id('p2', 'battlefield', 'Darksteel Myr'))], payment: swamps.slice(3) });
    resolve(d);
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
    expect(d.ids('p2', 'battlefield', 'Darksteel Myr')).toHaveLength(1);
  });
});

describe('lands with choices', () => {
  it('a shock land enters untapped if you pay 2 life, tapped otherwise (614.12)', () => {
    const d = start({ p1: { hand: ['Watery Grave'] } });
    d.do({ kind: 'playLand', card: d.id('p1', 'hand', 'Watery Grave'), payLife: true });
    expect(d.state.players.p1.life).toBe(18);
    expect(d.state.objects[d.id('p1', 'battlefield', 'Watery Grave')]?.tapped).toBe(false);

    const e = start({ p1: { hand: ['Watery Grave'] } });
    e.do({ kind: 'playLand', card: e.id('p1', 'hand', 'Watery Grave') });
    expect(e.state.players.p1.life).toBe(20);
    expect(e.state.objects[e.id('p1', 'battlefield', 'Watery Grave')]?.tapped).toBe(true);
  });

  it('a dual land pays whichever color is needed, and can make a chosen color', () => {
    const d = start({ p1: { hand: ['Murder'], battlefield: ['Watery Grave', 'Island', 'Swamp'] }, p2: { battlefield: ['Grizzly Bears'] } });
    const payment = [d.id('p1', 'battlefield', 'Watery Grave'), d.id('p1', 'battlefield', 'Island'), d.id('p1', 'battlefield', 'Swamp')];
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Murder'), targets: [obj(d.id('p2', 'battlefield', 'Grizzly Bears'))], payment });
    resolve(d);
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);

    const e = start({ p1: { battlefield: ['Watery Grave'] } });
    e.do({ kind: 'activateMana', source: e.id('p1', 'battlefield', 'Watery Grave'), mana: 'B' });
    expect(e.state.players.p1.manaPool.B).toBe(1);
    expect(e.reject({ kind: 'activateMana', source: e.id('p1', 'battlefield', 'Watery Grave'), mana: 'R' })).toMatch(/Cannot activate/);
  });
});

describe('legend rule (704.5j)', () => {
  it('a second copy of a legend makes its controller keep only one', () => {
    const d = start({ p1: { hand: ['Isamaru, Hound of Konda'], battlefield: ['Isamaru, Hound of Konda', 'Plains'] } });
    const old = d.id('p1', 'battlefield', 'Isamaru, Hound of Konda');
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Isamaru, Hound of Konda'), targets: [], payment: [d.id('p1', 'battlefield', 'Plains')] });
    resolve(d);
    const choice = d.pending('legendRule');
    expect(choice.candidates).toHaveLength(2);
    const keep = choice.candidates.find((id) => id !== old) as string;
    d.do({ kind: 'legendRule', keep });
    expect(d.ids('p1', 'battlefield', 'Isamaru, Hound of Konda')).toEqual([keep]);
    expect(d.ids('p1', 'graveyard', 'Isamaru, Hound of Konda')).toHaveLength(1);
    expect(d.pending('priority').player).toBe('p1');
  });
});
