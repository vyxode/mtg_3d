import { describe, expect, it } from 'vitest';
import { emptyPool, parseManaCost, solvePayment } from './mana';

describe('solvePayment', () => {
  it('uses a dual land for the color only it can make, even when listed first', () => {
    const r = solvePayment(emptyPool(), [{ id: 'grave', produce: ['U', 'B'] }, { id: 'island', produce: ['U'] }], parseManaCost('{U}{B}'));
    expect(r).toEqual([{ id: 'grave', mana: 'B' }, { id: 'island', mana: 'U' }]);
  });

  it('counts floating mana and taps only what is needed', () => {
    const pool = { ...emptyPool(), R: 1 };
    expect(solvePayment(pool, [{ id: 'm1', produce: ['R'] }, { id: 'm2', produce: ['R'] }], parseManaCost('{1}{R}'))).toEqual([{ id: 'm1', mana: 'R' }]);
  });

  it('returns null when no assignment works', () => {
    expect(solvePayment(emptyPool(), [{ id: 'f', produce: ['G'] }], parseManaCost('{U}'))).toBeNull();
  });
});
