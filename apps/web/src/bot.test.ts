import { describe, expect, it } from 'vitest';
import { CARDS, PRESET_DECKS } from '@mtg3d/cards';
import { createGame, step, viewFor, type GameState } from '@mtg3d/engine';
import { botResponse } from './bot';

describe('practice bot', () => {
  it('plays whole games against itself with every preset deck, without an illegal move', () => {
    const decks = Object.values(PRESET_DECKS);
    let finished = 0;
    for (let g = 0; g < decks.length * 2; g++) {
      const created = createGame({ seed: g + 1, decks: { p1: decks[g % decks.length] as string[], p2: decks[(g + 1) % decks.length] as string[] } }, CARDS);
      if (!created.ok) throw new Error(created.error);
      let s: GameState = created.state;
      for (let n = 0; n < 6000 && !s.result; n++) {
        const p = s.pending;
        if (!p) throw new Error('no decision');
        const response = botResponse(viewFor(s, CARDS, p.player));
        if (!response) throw new Error(`no answer to ${p.kind}`);
        const r = step(s, { player: p.player, decisionId: p.id, response }, CARDS);
        if (!r.ok) throw new Error(`${p.kind}: ${r.error}`);
        s = r.state;
      }
      if (s.result) finished++;
    }
    expect(finished).toBeGreaterThanOrEqual(decks.length * 2 - 1); // a rare stalemate may hit the step cap
  });
});
