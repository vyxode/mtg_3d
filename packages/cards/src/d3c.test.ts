import { describe, expect, it } from 'vitest';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const obj = (id: string) => ({ kind: 'object', id }) as const;
const resolve = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });

describe("Meltstrider's Resolve (Auras, fight, up to one target)", () => {
  it('enchants a creature you control, which fights the chosen creature and gets +0/+2', () => {
    const d = start({ p1: { hand: ["Meltstrider's Resolve"], battlefield: ['Grizzly Bears', 'Forest'] }, p2: { battlefield: ['Savannah Lions', 'Hill Giant'] } });
    const bear = d.id('p1', 'battlefield', 'Grizzly Bears');
    const lions = d.id('p2', 'battlefield', 'Savannah Lions');
    expect(d.reject({ kind: 'cast', card: d.id('p1', 'hand', "Meltstrider's Resolve"), targets: [obj(lions)], payment: [d.id('p1', 'battlefield', 'Forest')] })).toMatch(/Illegal target/);
    d.do({ kind: 'cast', card: d.id('p1', 'hand', "Meltstrider's Resolve"), targets: [obj(bear)], payment: [d.id('p1', 'battlefield', 'Forest')] });
    resolve(d);
    const aura = d.id('p1', 'battlefield', "Meltstrider's Resolve");
    expect(d.state.objects[aura]?.attachedTo).toBe(bear);
    expect(d.toughness(bear)).toBe(4);
    const choose = d.pending('chooseTargets');
    expect(choose.optional).toBe(true);
    d.do({ kind: 'chooseTargets', targets: [obj(lions)] });
    resolve(d);
    expect(d.ids('p2', 'graveyard', 'Savannah Lions')).toHaveLength(1); // 2 damage to a 2/1
    expect(d.state.objects[bear]?.damage).toBe(2); // 2 damage to a 2/4: survives
  });

  it('may fight nothing; and the Aura goes to the graveyard when its creature dies (704.5m)', () => {
    const d = start({ p1: { hand: ["Meltstrider's Resolve"], battlefield: ['Grizzly Bears', 'Forest'] }, p2: { hand: ['Murder'], battlefield: ['Savannah Lions', 'Swamp', 'Swamp', 'Swamp'] } });
    const bear = d.id('p1', 'battlefield', 'Grizzly Bears');
    d.do({ kind: 'cast', card: d.id('p1', 'hand', "Meltstrider's Resolve"), targets: [obj(bear)], payment: [d.id('p1', 'battlefield', 'Forest')] });
    resolve(d);
    d.do({ kind: 'chooseTargets', targets: [] });
    resolve(d);
    expect(d.state.objects[bear]?.damage).toBe(0);
    d.do({ kind: 'pass' });
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Murder'), targets: [obj(bear)], payment: d.ids('p2', 'battlefield', 'Swamp') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.ids('p1', 'graveyard', "Meltstrider's Resolve")).toHaveLength(1);
  });

  it("the enchanted creature can't be blocked by more than one creature", () => {
    const d = start({ step: 'declareBlockers', p1: { battlefield: ['Grizzly Bears', "Meltstrider's Resolve"] }, p2: { battlefield: ['Savannah Lions', 'Walking Corpse'] } });
    const bear = d.id('p1', 'battlefield', 'Grizzly Bears');
    const s = d.state;
    (s.objects[d.id('p1', 'battlefield', "Meltstrider's Resolve")] as (typeof s.objects)[string]).attachedTo = bear;
    s.combat = { attackers: [{ id: bear, defending: 'p2' }], blocks: [], assignments: {}, damageStep: null, firstStrikers: [] };
    const blockers = [d.id('p2', 'battlefield', 'Savannah Lions'), d.id('p2', 'battlefield', 'Walking Corpse')];
    s.pending = { id: 99, kind: 'declareBlockers', player: 'p2', candidates: blockers.map((b) => ({ blocker: b, attackers: [bear] })) };
    expect(d.reject({ kind: 'declareBlockers', blocks: blockers.map((b) => ({ blocker: b, attacker: bear })) })).toMatch(/more than 1/);
    d.do({ kind: 'declareBlockers', blocks: [{ blocker: blockers[0] as string, attacker: bear }] });
  });
});

describe('Demolition Field', () => {
  it("destroys an opponent's nonbasic land; its controller searches first, then you", () => {
    const d = start({
      p1: { battlefield: ['Demolition Field', 'Forest', 'Forest'], library: ['Forest'] },
      p2: { battlefield: ['Steam Vents', 'Island'], library: ['Mountain', 'Island'] },
    });
    expect(d.reject({ kind: 'activate', source: d.id('p1', 'battlefield', 'Demolition Field'), ability: 0, targets: [obj(d.id('p2', 'battlefield', 'Island'))], payment: d.ids('p1', 'battlefield', 'Forest') })).toMatch(/Illegal target/);
    d.do({ kind: 'activate', source: d.id('p1', 'battlefield', 'Demolition Field'), ability: 0, targets: [obj(d.id('p2', 'battlefield', 'Steam Vents'))], payment: d.ids('p1', 'battlefield', 'Forest') });
    resolve(d);
    expect(d.pending('searchLibrary').player).toBe('p2');
    d.do({ kind: 'searchLibrary', card: 'Mountain' });
    expect(d.pending('searchLibrary').player).toBe('p1');
    d.do({ kind: 'searchLibrary', card: 'Forest' });
    expect(d.ids('p2', 'graveyard', 'Steam Vents')).toHaveLength(1);
    expect(d.state.objects[d.id('p2', 'battlefield', 'Mountain')]?.tapped).toBe(false);
    expect(d.ids('p1', 'battlefield', 'Forest')).toHaveLength(3);
  });
});

describe('Keen-Eyed Curator', () => {
  it('exiles cards from graveyards and grows with four card types among them', () => {
    const d = start({
      p1: { battlefield: ['Keen-Eyed Curator', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'], graveyard: ['Lightning Bolt', 'Divination'] },
      p2: { graveyard: ['Grizzly Bears', 'Glorious Anthem', 'Shock'] },
    });
    const curator = d.id('p1', 'battlefield', 'Keen-Eyed Curator');
    const forests = d.ids('p1', 'battlefield', 'Forest');
    const exile = (zoneOwner: 'p1' | 'p2', card: string, payer: string) => {
      d.do({ kind: 'activate', source: curator, ability: 0, targets: [obj(d.id(zoneOwner, 'graveyard', card))], payment: [payer] });
      resolve(d);
    };
    exile('p1', 'Lightning Bolt', forests[0] as string);
    exile('p2', 'Shock', forests[1] as string); // a second instant adds no new type
    exile('p2', 'Grizzly Bears', forests[2] as string);
    exile('p1', 'Divination', forests[3] as string);
    expect(d.power(curator)).toBe(3); // instant, creature, sorcery: three types
    exile('p2', 'Glorious Anthem', forests[4] as string);
    expect([d.power(curator), d.toughness(curator)]).toEqual([7, 7]);
    expect(d.state.effects).toEqual([]);
  });
});
