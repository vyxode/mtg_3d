import { describe, expect, it } from 'vitest';
import { drive, scenario } from '@mtg3d/engine/testing';
import { CARDS, PRESET_DECKS, validateCasualDeck } from './index';

describe('decks', () => {
  it('every preset deck is legal in casual constructed', () => {
    for (const [name, deck] of Object.entries(PRESET_DECKS)) expect([name, validateCasualDeck(deck, CARDS)]).toEqual([name, []]);
  });

  it('rejects short decks, a fifth copy and unknown cards, but allows any number of basic lands', () => {
    const base = Array<string>(56).fill('Forest');
    expect(validateCasualDeck(base, CARDS)).toEqual([expect.stringMatching(/mínimo es 60/)]);
    expect(validateCasualDeck([...base, ...Array<string>(5).fill('Grizzly Bears')], CARDS)).toEqual([expect.stringMatching(/máximo es 4/)]);
    expect(validateCasualDeck([...base, ...Array<string>(4).fill('Black Lotus')], CARDS)).toEqual([expect.stringMatching(/no está implementada/)]);
    expect(validateCasualDeck(Array<string>(60).fill('Forest'), CARDS)).toEqual([]);
  });

  it('Divination draws two cards for its controller', () => {
    const d = drive(CARDS, scenario(CARDS, { p1: { hand: ['Divination'], battlefield: ['Island', 'Island', 'Island'], library: ['Forest', 'Forest', 'Forest'] } }));
    d.do({ kind: 'cast', card: d.id('p1', 'hand', 'Divination'), targets: [], payment: d.ids('p1', 'battlefield', 'Island') });
    d.do({ kind: 'pass' }).do({ kind: 'pass' });
    expect(d.state.zones.hand.p1).toHaveLength(2);
    expect(d.state.zones.library.p1).toHaveLength(1);
  });
});
