import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@mtg3d/engine';
import { soundsFor } from './sounds';

describe('soundsFor', () => {
  it('makes one sound per kind, in order, from the viewer’s point of view', () => {
    const events = [
      { kind: 'turnStarted', active: 'p2', turn: 2 },
      { kind: 'drew', player: 'p2', card: 'o1' },
      { kind: 'damage', source: 'o2', target: { kind: 'player', player: 'p1' }, amount: 2, combat: true },
      { kind: 'lifeChanged', player: 'p1', from: 20, to: 18 },
      { kind: 'gameOver', result: { winner: 'p1' } },
    ] as unknown as GameEvent[];
    expect(soundsFor(events, 'p1')).toEqual(['theirTurn', 'draw', 'hit', 'win']);
    expect(soundsFor(events, 'p2')).toEqual(['myTurn', 'draw', 'hit', 'lose']);
  });
});
