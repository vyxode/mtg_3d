import { describe, expect, it } from 'vitest';
import { createGame, step, type GameState, type Step } from '@mtg3d/engine';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const P2 = { kind: 'player', player: 'p2' } as const;
const obj = (id: string) => ({ kind: 'object', id }) as const;

/** Passes priority until `step` is reached with someone holding priority there. */
function passTo(d: Driver, target: Step): Driver {
  for (let i = 0; i < 50; i++) {
    const p = d.state.pending;
    if (p?.kind === 'priority' && d.state.turn.step === target) return d;
    if (p?.kind !== 'priority') throw new Error(`Unexpected decision ${String(p?.kind)} before ${target}`);
    d.do({ kind: 'pass' });
  }
  throw new Error(`Never reached ${target}`);
}

describe('priority and the stack', () => {
  it('lets the opponent respond, gives the caster priority back, and resolves LIFO (117.3c, 608.1)', () => {
    const d = start({
      p1: { hand: ['Lightning Bolt'], battlefield: ['Mountain'] },
      p2: { hand: ['Counterspell'], battlefield: ['Island', 'Island'] },
    });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [P2], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    expect(d.pending('priority').player).toBe('p1');
    d.do({ kind: 'pass' });
    expect(d.pending('priority').player).toBe('p2');

    const bolt = (d.state.stack[0] as { id: string }).id;
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Counterspell'), targets: [obj(bolt)], payment: d.ids('p2', 'battlefield', 'Island') });
    expect(d.pending('priority').player).toBe('p2');
    expect(d.state.stack).toHaveLength(2);

    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.stack).toHaveLength(0);
    expect(d.state.players.p2.life).toBe(20);
    expect(d.ids('p1', 'graveyard', 'Lightning Bolt')).toHaveLength(1);
    expect(d.ids('p2', 'graveyard', 'Counterspell')).toHaveLength(1);
    expect(d.events.some((e) => e.kind === 'countered')).toBe(true);
    expect(d.state.turn.step).toBe('main1');
  });

  it('does not advance the step until both players pass in succession with an empty stack', () => {
    const d = start({});
    d.do({ kind: 'pass' });
    expect(d.state.turn.step).toBe('main1');
    expect(d.pending('priority').player).toBe('p2');
    d.do({ kind: 'pass' });
    expect(d.state.turn.step).toBe('beginCombat');
  });

  it('resets the pass count when a player acts after the other passed', () => {
    const d = start({ p2: { hand: ['Shock'], battlefield: ['Mountain'] } });
    d.do({ kind: 'pass' });
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Shock'), targets: [{ kind: 'player', player: 'p1' }], payment: [d.id('p2', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' });
    expect(d.state.stack).toHaveLength(1); // p1 must pass again before it resolves
    d.do({ kind: 'pass' });
    expect(d.state.players.p1.life).toBe(18);
  });

  it('a spell whose only target became illegal does not resolve (608.2b)', () => {
    const d = start({ p1: { hand: ['Lightning Bolt', 'Shock'], battlefield: ['Mountain', 'Mountain'] }, p2: { battlefield: ['Grizzly Bears'] } });
    const [m1, m2] = d.ids('p1', 'battlefield', 'Mountain') as [string, string];
    const bears = obj(d.id('p2', 'battlefield', 'Grizzly Bears'));
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [bears], payment: [m1] });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shock'), targets: [bears], payment: [m2] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' }); // Shock resolves, Bears die to SBA
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
    d.do({ kind: 'pass' }).do({ kind: 'pass' }); // Bolt fizzles
    expect(d.events.some((e) => e.kind === 'fizzled')).toBe(true);
    expect(d.ids('p1', 'graveyard', 'Lightning Bolt')).toHaveLength(1);
    expect(d.state.players.p2.life).toBe(20);
  });
});

describe('casting restrictions', () => {
  it('rejects a sorcery while the stack is not empty, but allows an instant', () => {
    const d = start({ p1: { hand: ['Shock', 'Divination', 'Lightning Bolt'], battlefield: ['Mountain', 'Mountain', 'Island', 'Island', 'Island'] } });
    const [m1, m2] = d.ids('p1', 'battlefield', 'Mountain') as [string, string];
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Shock'), targets: [P2], payment: [m1] });
    expect(d.reject({ kind: 'cast', card: d.id('p1', 'hand', 'Divination'), targets: [], payment: d.ids('p1', 'battlefield', 'Island') })).toMatch(/sorcery speed/);
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [P2], payment: [m2] });
    expect(d.state.stack).toHaveLength(2);
  });

  it('rejects a spell it cannot pay for and leaves the state untouched', () => {
    const d = start({ p1: { hand: ['Divination'], battlefield: ['Island'] } });
    const before = JSON.parse(JSON.stringify(d.state)) as GameState;
    expect(d.reject({ kind: 'cast', card: d.id('p1', 'hand', 'Divination'), targets: [], payment: [d.id('p1', 'battlefield', 'Island')] })).toMatch(/Not enough mana/);
    expect(d.state).toEqual(before);
  });

  it('allows one land per turn, only in your own main phase with an empty stack', () => {
    const d = start({ p1: { hand: ['Forest', 'Forest'] }, p2: { hand: ['Forest'] } });
    const [f1, f2] = d.ids('p1', 'hand', 'Forest') as [string, string];
    d.do({ kind: 'playLand', card: f1 });
    expect(d.reject({ kind: 'playLand', card: f2 })).toMatch(/already played/);
    d.do({ kind: 'pass' });
    expect(d.reject({ kind: 'playLand', card: d.id('p2', 'hand', 'Forest') })).toMatch(/main phase/);
  });

  it('a creature cannot use {T} mana abilities or attack the turn it arrives (302.6)', () => {
    const d = start({ p1: { battlefield: [{ card: 'Llanowar Elves', sick: true }] } });
    expect(d.reject({ kind: 'activateMana', source: d.id('p1', 'battlefield', 'Llanowar Elves') })).toMatch(/Cannot activate/);
    passTo(d, 'declareAttackers'); // no candidates, so no attack declaration is asked
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.turn.step).toBe('endCombat'); // 508.8: blockers and damage steps skipped
  });

  it('empties mana pools when a step ends (500.4)', () => {
    const d = start({ p1: { battlefield: ['Mountain'] } });
    d.do({ kind: 'activateMana', source: d.id('p1', 'battlefield', 'Mountain') });
    expect(d.state.players.p1.manaPool.R).toBe(1);
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.players.p1.manaPool.R).toBe(0);
  });
});

describe('damage and state-based actions', () => {
  it('a creature with lethal damage is destroyed (704.5g)', () => {
    const d = start({ p1: { hand: ['Lightning Bolt'], battlefield: ['Mountain'] }, p2: { battlefield: ['Grizzly Bears'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [obj(d.id('p2', 'battlefield', 'Grizzly Bears'))], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
  });

  it('Giant Growth in response saves the creature; damage and the bonus end at cleanup (514.2)', () => {
    const d = start({ p1: { hand: ['Lightning Bolt'], battlefield: ['Mountain'] }, p2: { hand: ['Giant Growth'], battlefield: ['Grizzly Bears', 'Forest'] } });
    const bears = d.id('p2', 'battlefield', 'Grizzly Bears');
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [obj(bears)], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' });
    d.do({ kind: 'cast', card: d.id('p2', 'hand', 'Giant Growth'), targets: [obj(bears)], payment: [d.id('p2', 'battlefield', 'Forest')] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.power(bears)).toBe(5);
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.objects[bears]?.damage).toBe(3);
    passTo(d, 'end').do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.turn.active).toBe('p2');
    expect(d.state.objects[bears]?.damage).toBe(0);
    expect(d.power(bears)).toBe(2);
  });

  it('a player at 0 life loses and the game ends (704.5a)', () => {
    const d = start({ p1: { hand: ['Lightning Bolt'], battlefield: ['Mountain'] }, p2: { life: 3 } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [P2], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.result).toEqual({ winner: 'p1', reason: 'opponentLost' });
    expect(d.state.pending).toBeNull();
  });

  it('drawing from an empty library loses the game at the next SBA check (704.5b)', () => {
    const d = start({ step: 'upkeep' });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.result?.winner).toBe('p2');
  });

  it('discards down to seven at cleanup', () => {
    const d = start({ step: 'end', p1: { hand: Array<string>(9).fill('Forest') } });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    const pend = d.pending('discard');
    expect(pend.count).toBe(2);
    const hand = d.state.zones.hand.p1;
    expect(d.reject({ kind: 'discard', cards: hand.slice(0, 1) })).toMatch(/exactly 2/);
    d.do({ kind: 'discard', cards: hand.slice(0, 2) });
    expect(d.state.zones.hand.p1).toHaveLength(7);
    expect(d.state.turn.active).toBe('p2');
  });
});

describe('combat', () => {
  const toAttack = (d: Driver) => { passTo(d, 'beginCombat').do({ kind: 'pass' }).do({ kind: 'pass' }); return d; };

  it('an unblocked attacker damages the defending player', () => {
    const d = toAttack(start({ p1: { battlefield: ['Grizzly Bears'] } }));
    d.do({ kind: 'declareAttackers', attackers: [d.id('p1', 'battlefield', 'Grizzly Bears')] });
    expect(d.state.objects[d.id('p1', 'battlefield', 'Grizzly Bears')]?.tapped).toBe(true);
    passTo(d, 'combatDamage');
    expect(d.state.players.p2.life).toBe(18);
  });

  it('blocked creatures deal damage to each other and both die', () => {
    const d = toAttack(start({ p1: { battlefield: ['Grizzly Bears'] }, p2: { battlefield: ['Walking Corpse'] } }));
    const bears = d.id('p1', 'battlefield', 'Grizzly Bears');
    d.do({ kind: 'declareAttackers', attackers: [bears] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    d.do({ kind: 'declareBlockers', blocks: [{ blocker: d.id('p2', 'battlefield', 'Walking Corpse'), attacker: bears }] });
    passTo(d, 'combatDamage');
    expect(d.state.players.p2.life).toBe(20);
    expect(d.ids('p1', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
    expect(d.ids('p2', 'graveyard', 'Walking Corpse')).toHaveLength(1);
  });

  it('the attacker divides damage freely among several blockers (510.1c, no damage order since Foundations)', () => {
    const d = toAttack(start({ p1: { battlefield: ['Hill Giant'] }, p2: { battlefield: ['Grizzly Bears', 'Walking Corpse'] } }));
    const giant = d.id('p1', 'battlefield', 'Hill Giant');
    const bears = d.id('p2', 'battlefield', 'Grizzly Bears');
    const corpse = d.id('p2', 'battlefield', 'Walking Corpse');
    d.do({ kind: 'declareAttackers', attackers: [giant] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    d.do({ kind: 'declareBlockers', blocks: [{ blocker: bears, attacker: giant }, { blocker: corpse, attacker: giant }] });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.pending('assignCombatDamage').amount).toBe(3);
    expect(d.reject({ kind: 'assignCombatDamage', assignment: { [bears]: 2 } })).toMatch(/exactly 3/);
    d.do({ kind: 'assignCombatDamage', assignment: { [bears]: 3, [corpse]: 0 } });
    expect(d.ids('p2', 'graveyard', 'Grizzly Bears')).toHaveLength(1);
    expect(d.ids('p2', 'battlefield', 'Walking Corpse')).toHaveLength(1);
    expect(d.ids('p1', 'graveyard', 'Hill Giant')).toHaveLength(1); // took 4
  });
});

describe('game setup and inputs', () => {
  const deck = [...Array<string>(20).fill('Forest'), ...Array<string>(20).fill('Grizzly Bears')];

  it('runs the London mulligan and the starting player skips their first draw (103.5, 103.8a)', () => {
    const created = createGame({ seed: 7, decks: { p1: deck, p2: deck } }, CARDS);
    if (!created.ok) throw new Error(created.error);
    const d = drive(CARDS, created.state);
    d.do({ kind: 'chooseStartingPlayer', first: 'p1' });
    expect(d.pending('mulligan').player).toBe('p1');
    d.do({ kind: 'mulligan' });
    expect(d.state.zones.hand.p1).toHaveLength(7);
    d.do({ kind: 'keep' });
    expect(d.pending('bottomCards').count).toBe(1);
    d.do({ kind: 'bottomCards', cards: d.state.zones.hand.p1.slice(0, 1) });
    d.do({ kind: 'keep' }); // p2
    expect(d.state.turn).toMatchObject({ number: 1, active: 'p1', step: 'upkeep' });
    expect(d.state.zones.hand.p1).toHaveLength(6);
    passTo(d, 'main1');
    expect(d.state.zones.hand.p1).toHaveLength(6);
    expect(d.state.zones.library.p1).toHaveLength(34);
  });

  it('rejects unknown cards in a deck', () => {
    const r = createGame({ seed: 1, decks: { p1: ['Black Lotus'], p2: deck } }, CARDS);
    expect(r.ok).toBe(false);
  });

  it('rejects stale decisions and answers from the wrong player', () => {
    const s: GameState = scenario(CARDS, {});
    const pend = s.pending as { id: number };
    expect(step(s, { player: 'p1', decisionId: pend.id + 1, response: { kind: 'pass' } }, CARDS)).toMatchObject({ ok: false, error: 'Stale decision' });
    expect(step(s, { player: 'p2', decisionId: pend.id, response: { kind: 'pass' } }, CARDS)).toMatchObject({ ok: false, error: 'It is not your decision' });
  });

  it('a player can concede at any time (104.3a)', () => {
    const r = step(scenario(CARDS, {}), { player: 'p2', concede: true }, CARDS);
    expect(r.ok && r.state.result).toEqual({ winner: 'p1', reason: 'opponentLost' });
  });
});
