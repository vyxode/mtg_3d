import { describe, expect, it } from 'vitest';
import { nextInt, nextUint32, seedRng, shuffle, type RngState } from './rng';

const draw = (s: RngState, n: number): number[] => {
  const out: number[] = [];
  let state = s;
  for (let i = 0; i < n; i++) {
    const [x, next] = nextUint32(state);
    out.push(x);
    state = next;
  }
  return out;
};

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    expect(draw(seedRng(42), 100)).toEqual(draw(seedRng(42), 100));
  });

  it('produces different sequences for different seeds', () => {
    expect(draw(seedRng(1), 10)).not.toEqual(draw(seedRng(2), 10));
  });

  it('returns uint32 values', () => {
    for (const x of draw(seedRng(7), 1000)) {
      expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
    }
  });

  it('nextInt stays in range and covers every value', () => {
    let state = seedRng(123);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const [x, next] = nextInt(state, 7);
      state = next;
      expect(x >= 0 && x < 7).toBe(true);
      seen.add(x);
    }
    expect(seen.size).toBe(7);
  });

  it('nextInt rejects invalid bounds', () => {
    expect(() => nextInt(seedRng(1), 0)).toThrow(RangeError);
    expect(() => nextInt(seedRng(1), 2.5)).toThrow(RangeError);
  });

  it('shuffle is a deterministic permutation and does not mutate its input', () => {
    const deck = Array.from({ length: 60 }, (_, i) => i);
    const [a] = shuffle(deck, seedRng(99));
    const [b] = shuffle(deck, seedRng(99));
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(deck);
    expect(a).not.toEqual(deck);
    expect(deck).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('rejects unsafe seeds', () => {
    expect(() => seedRng(Number.NaN)).toThrow(RangeError);
  });
});
