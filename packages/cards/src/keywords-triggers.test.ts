import { describe, expect, it } from 'vitest';
import type { Step } from '@mtg3d/engine';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const obj = (id: string) => ({ kind: 'object', id }) as const;

function passTo(d: Driver, target: Step): Driver {
  for (let i = 0; i < 50; i++) {
    const p = d.state.pending;
    if (p?.kind === 'priority' && d.state.turn.step === target) return d;
    if (p?.kind !== 'priority') throw new Error(`Unexpected decision ${String(p?.kind)} before ${target}`);
    d.do({ kind: 'pass' });
  }
  throw new Error(`Never reached ${target}`);
}

/** Main phase → declare attackers decision. */
const toAttack = (d: Driver) => { passTo(d, 'beginCombat').do({ kind: 'pass' }).do({ kind: 'pass' }); return d; };
/** After attackers: both pass → declare blockers decision (if any). */
const toBlocks = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });

describe('evasion and attack restrictions', () => {
  it('flying can only be blocked by flying or reach (702.9b, 702.17b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Wind Drake'] }, p2: { battlefield: ['Grizzly Bears', 'Giant Spider'] } }));
    const drake = d.id('p1', 'battlefield', 'Wind Drake');
    d.do({ kind: 'declareAttackers', attackers: [drake] });
    toBlocks(d);
    const blockers = d.pending('declareBlockers').candidates.map((c) => d.state.objects[c.blocker]?.card);
    expect(blockers).toEqual(['Giant Spider']);
  });

  it('vigilance does not tap; haste attacks the turn it arrives; defender never attacks', () => {
    const d = toAttack(start({ p1: { battlefield: ['Serra Angel', { card: 'Raging Goblin', sick: true }, 'Wall of Stone'] } }));
    const cards = d.pending('declareAttackers').candidates.map((id) => d.state.objects[id]?.card).sort();
    expect(cards).toEqual(['Raging Goblin', 'Serra Angel']);
    const angel = d.id('p1', 'battlefield', 'Serra Angel');
    d.do({ kind: 'declareAttackers', attackers: [angel] });
    expect(d.state.objects[angel]?.tapped).toBe(false);
  });

  it('menace needs two or more blockers (702.110b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Boggart Brute'] }, p2: { battlefield: ['Grizzly Bears', 'Walking Corpse'] } }));
    const brute = d.id('p1', 'battlefield', 'Boggart Brute');
    d.do({ kind: 'declareAttackers', attackers: [brute] });
    toBlocks(d);
    const bears = d.id('p2', 'battlefield', 'Grizzly Bears');
    const corpse = d.id('p2', 'battlefield', 'Walking Corpse');
    expect(d.reject({ kind: 'declareBlockers', blocks: [{ blocker: bears, attacker: brute }] })).toMatch(/menace/);
    d.do({ kind: 'declareBlockers', blocks: [{ blocker: bears, attacker: brute }, { blocker: corpse, attacker: brute }] });
  });
});

describe('combat damage keywords', () => {
  it('first strike kills a blocker before it can strike back (510.4)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Youthful Knight'] }, p2: { battlefield: ['Grizzly Bears'] } }));
    const knight = d.id('p1', 'battlefield', 'Youthful Knight');
    d.do({ kind: 'declareAttackers', attackers: [knight] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: d.id('p2', 'battlefield', 'Grizzly Bears'), attacker: knight }] });
    passTo(d, 'endCombat');
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
    expect(d.ids('p1', 'battlefield', 'Youthful Knight')).toHaveLength(1);
    expect(d.events.filter((e) => e.kind === 'stepStarted' && e.step === 'combatDamage')).toHaveLength(2);
  });

  it('double strike deals damage in both combat damage steps (702.4b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Fencing Ace'] } }));
    d.do({ kind: 'declareAttackers', attackers: [d.id('p1', 'battlefield', 'Fencing Ace')] });
    passTo(d, 'endCombat');
    expect(d.state.players.p2.life).toBe(18);
  });

  it('any damage from deathtouch is lethal (704.5h)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Craw Wurm'] }, p2: { battlefield: ['Typhoid Rats'] } }));
    const wurm = d.id('p1', 'battlefield', 'Craw Wurm');
    d.do({ kind: 'declareAttackers', attackers: [wurm] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: d.id('p2', 'battlefield', 'Typhoid Rats'), attacker: wurm }] });
    passTo(d, 'endCombat');
    expect(d.ids('p1', 'graveyard', 'Craw Wurm')).toHaveLength(1);
    expect(d.ids('p2', 'graveyard', 'Typhoid Rats')).toHaveLength(1);
  });

  it('trample must assign lethal damage to blockers before the player (702.19b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Colossal Dreadmaw'] }, p2: { battlefield: ['Grizzly Bears'] } }));
    const maw = d.id('p1', 'battlefield', 'Colossal Dreadmaw');
    const bears = d.id('p2', 'battlefield', 'Grizzly Bears');
    d.do({ kind: 'declareAttackers', attackers: [maw] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: bears, attacker: maw }] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.pending('assignCombatDamage')).toMatchObject({ trample: true, amount: 6, lethal: { [bears]: 2 } });
    expect(d.reject({ kind: 'assignCombatDamage', assignment: { [bears]: 1, player: 5 } })).toMatch(/lethal/);
    d.do({ kind: 'assignCombatDamage', assignment: { [bears]: 2, player: 4 } });
    expect(d.state.players.p2.life).toBe(16);
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
  });

  it('a trampler whose blockers all left deals all its damage to the player (702.19e)', () => {
    const d = toAttack(start({ p1: { hand: ['Shock'], battlefield: ['Colossal Dreadmaw', 'Mountain'] }, p2: { battlefield: ['Grizzly Bears'] } }));
    const maw = d.id('p1', 'battlefield', 'Colossal Dreadmaw');
    const bears = d.id('p2', 'battlefield', 'Grizzly Bears');
    d.do({ kind: 'declareAttackers', attackers: [maw] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: bears, attacker: maw }] });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shock'), targets: [obj(bears)], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }); // Shock resolves
    passTo(d, 'endCombat');
    expect(d.state.players.p2.life).toBe(14);
  });

  it('lifelink gains life as the damage is dealt (702.15b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Vampire Nighthawk'] } }));
    d.do({ kind: 'declareAttackers', attackers: [d.id('p1', 'battlefield', 'Vampire Nighthawk')] });
    passTo(d, 'endCombat');
    expect(d.state.players.p1.life).toBe(22);
    expect(d.state.players.p2.life).toBe(18);
  });

  it('indestructible ignores lethal damage but not zero toughness (702.12b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Hill Giant'] }, p2: { battlefield: ['Darksteel Myr'] } }));
    const giant = d.id('p1', 'battlefield', 'Hill Giant');
    const myr = d.id('p2', 'battlefield', 'Darksteel Myr');
    d.do({ kind: 'declareAttackers', attackers: [giant] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: myr, attacker: giant }] });
    passTo(d, 'endCombat');
    expect(d.state.objects[myr]?.damage).toBe(3);
    expect(d.ids('p2', 'battlefield', 'Darksteel Myr')).toHaveLength(1);
  });
});

describe('triggered abilities', () => {
  it('an enters trigger goes on the stack and both players get priority before it resolves (603.3)', () => {
    const d = start({ p1: { hand: ['Elvish Visionary'], battlefield: ['Forest', 'Forest'], library: ['Island'] }, p2: { hand: ['Counterspell'], battlefield: ['Island', 'Island'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Elvish Visionary'), targets: [], payment: d.ids('p1', 'battlefield', 'Forest') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }); // creature resolves, trigger goes on the stack
    expect(d.state.stack).toMatchObject([{ kind: 'ability', card: 'Elvish Visionary' }]);
    expect(d.pending('priority').player).toBe('p1');
    d.do({ kind: 'pass' });
    const ability = (d.state.stack[0] as { id: string }).id;
    expect(d.reject({ kind: 'cast', card: d.id('p2', 'hand', 'Counterspell'), targets: [obj(ability)], payment: d.ids('p2', 'battlefield', 'Island') })).toMatch(/Illegal target/);
    d.do({ kind: 'pass' });
    expect(d.state.zones.hand.p1).toHaveLength(1);
  });

  it('a dies trigger looks back: its controller is who controlled the creature (603.10a)', () => {
    const d = start({ p1: { hand: ['Shock'], battlefield: ['Mountain'] }, p2: { battlefield: ['Highland Game'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shock'), targets: [obj(d.id('p2', 'battlefield', 'Highland Game'))], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.stack).toMatchObject([{ kind: 'ability', card: 'Highland Game', controller: 'p2' }]);
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.players.p2.life).toBe(22);
  });

  it('a targeted trigger asks for its target when there is a real choice', () => {
    const d = start({ p1: { hand: ['Flametongue Kavu'], battlefield: Array<string>(4).fill('Mountain') }, p2: { battlefield: ['Grizzly Bears'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Flametongue Kavu'), targets: [], payment: d.ids('p1', 'battlefield', 'Mountain') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    const choose = d.pending('chooseTargets');
    expect(choose.targetOptions[0]).toHaveLength(2); // the Bears or the Kavu itself
    d.do({ kind: 'chooseTargets', targets: [obj(d.id('p2', 'battlefield', 'Grizzly Bears'))] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
    expect(d.ids('p1', 'battlefield', 'Flametongue Kavu')).toHaveLength(1);
  });

  it('a mandatory targeted trigger with only itself to target must target itself', () => {
    const d = start({ p1: { hand: ['Flametongue Kavu'], battlefield: Array<string>(4).fill('Mountain') } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Flametongue Kavu'), targets: [], payment: d.ids('p1', 'battlefield', 'Mountain') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }).do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.ids('p1', 'graveyard', 'Flametongue Kavu')).toHaveLength(1);
  });

  it('simultaneous triggers go on the stack in APNAP order, so the non-active player\'s resolves first (603.3b)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Highland Game'] }, p2: { battlefield: ['Highland Game'] } }));
    const mine = d.id('p1', 'battlefield', 'Highland Game');
    d.do({ kind: 'declareAttackers', attackers: [mine] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: d.id('p2', 'battlefield', 'Highland Game'), attacker: mine }] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }); // damage: both die
    expect(d.state.stack.map((e) => e.controller)).toEqual(['p1', 'p2']);
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.players).toMatchObject({ p1: { life: 20 }, p2: { life: 22 } });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.players.p1.life).toBe(22);
  });

  it('a player orders their own simultaneous triggers', () => {
    const d = toAttack(start({ p1: { battlefield: ['Highland Game', 'Highland Game'] }, p2: { battlefield: ['Grizzly Bears', 'Walking Corpse'] } }));
    const [g1, g2] = d.ids('p1', 'battlefield', 'Highland Game') as [string, string];
    d.do({ kind: 'declareAttackers', attackers: [g1, g2] });
    toBlocks(d).do({ kind: 'declareBlockers', blocks: [{ blocker: d.id('p2', 'battlefield', 'Grizzly Bears'), attacker: g1 }, { blocker: d.id('p2', 'battlefield', 'Walking Corpse'), attacker: g2 }] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    const order = d.pending('orderTriggers');
    expect(order.triggers).toHaveLength(2);
    expect(d.reject({ kind: 'orderTriggers', order: [order.triggers[0]?.id ?? ''] })).toMatch(/exactly once/);
    d.do({ kind: 'orderTriggers', order: order.triggers.map((t) => t.id).reverse() });
    expect(d.state.stack.map((e) => e.id)).toEqual(order.triggers.map((t) => t.id)); // first to resolve is on top
    passTo(d, 'endCombat');
    expect(d.state.players.p1.life).toBe(24);
  });

  it('a trigger with several effects applies them in order', () => {
    const d = start({ p1: { hand: ['Inspiring Overseer'], battlefield: ['Plains', 'Plains', 'Plains'], library: ['Plains'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Inspiring Overseer'), targets: [], payment: d.ids('p1', 'battlefield', 'Plains') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }).do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.players.p1.life).toBe(21);
    expect(d.state.zones.hand.p1).toHaveLength(1);
  });
});
