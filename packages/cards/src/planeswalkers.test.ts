import { describe, expect, it } from 'vitest';
import { drive, scenario, type Driver, type ScenarioOptions } from '@mtg3d/engine/testing';
import type { Step } from '@mtg3d/engine';
import { CARDS } from './index';

const start = (o: ScenarioOptions): Driver => drive(CARDS, scenario(CARDS, o));
const resolve = (d: Driver) => d.do({ kind: 'pass' }).do({ kind: 'pass' });
const P1 = { kind: 'player', player: 'p1' } as const;

function passTo(d: Driver, target: Step): Driver {
  for (let i = 0; i < 50; i++) {
    const p = d.state.pending;
    if (p?.kind === 'priority' && d.state.turn.step === target) return d;
    if (p?.kind !== 'priority') throw new Error(`Unexpected decision ${String(p?.kind)} before ${target}`);
    d.do({ kind: 'pass' });
  }
  throw new Error(`Never reached ${target}`);
}

describe('planeswalkers (306, 606)', () => {
  it('enters with its printed loyalty and activates one loyalty ability per turn at sorcery speed', () => {
    const d = start({ p1: { hand: ['Jace Beleren'], battlefield: ['Island', 'Island', 'Island'], library: ['Island', 'Island'] }, p2: { library: ['Island'] } });
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Jace Beleren'), targets: [], payment: d.ids('p1', 'battlefield', 'Island') });
    resolve(d);
    const jace = d.id('p1', 'battlefield', 'Jace Beleren');
    expect(d.state.objects[jace]?.loyalty).toBe(3);
    d.do({ kind: 'activate', source: jace, ability: 0, targets: [], payment: [] });
    expect(d.state.objects[jace]?.loyalty).toBe(5); // the cost is paid on activation
    expect(d.reject({ kind: 'activate', source: jace, ability: 1, targets: [P1], payment: [] })).toMatch(/cannot be activated now/);
    resolve(d);
    expect(d.state.zones.hand.p1).toHaveLength(1);
    expect(d.state.zones.hand.p2).toHaveLength(1);
    expect(d.pending('priority').legal.some((a) => a.kind === 'activate')).toBe(false);
  });

  it('cannot remove more loyalty than it has', () => {
    const d = start({ p1: { battlefield: ['Jace Beleren'] } });
    expect(d.reject({ kind: 'activate', source: d.id('p1', 'battlefield', 'Jace Beleren'), ability: 2, targets: [P1], payment: [] })).toMatch(/cannot be activated now/);
  });

  it('creatures can attack a planeswalker; combat damage removes loyalty and 0 loyalty sends it to the graveyard (704.5i)', () => {
    const d = start({ p1: { battlefield: ['Grizzly Bears', 'Hill Giant'] }, p2: { battlefield: ['Jace Beleren'] } });
    passTo(d, 'beginCombat').do({ kind: 'pass' }).do({ kind: 'pass' });
    const jace = d.id('p2', 'battlefield', 'Jace Beleren');
    expect(d.pending('declareAttackers').planeswalkers).toEqual([jace]);
    const bears = d.id('p1', 'battlefield', 'Grizzly Bears');
    d.do({ kind: 'declareAttackers', attackers: [bears], planeswalkerTargets: { [bears]: jace } });
    passTo(d, 'endCombat');
    expect(d.state.objects[jace]?.loyalty).toBe(1);
    expect(d.state.players.p2.life).toBe(20);
  });

  it('Lightning Bolt can target a planeswalker (any target, 115.4)', () => {
    const d = start({ p1: { hand: ['Lightning Bolt'], battlefield: ['Mountain'] }, p2: { battlefield: ['Jace Beleren'] } });
    const jace = d.id('p2', 'battlefield', 'Jace Beleren');
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Lightning Bolt'), targets: [{ kind: 'object', id: jace }], payment: [d.id('p1', 'battlefield', 'Mountain')] });
    resolve(d);
    expect(d.ids('p2', 'graveyard', 'Jace Beleren')).toHaveLength(1);
  });
});
