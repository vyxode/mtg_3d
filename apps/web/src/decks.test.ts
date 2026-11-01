import { describe, expect, it } from 'vitest';
import { CARDS } from '@mtg3d/cards';
import { colorSymbols, exportDeckText, manaCurve, newDeck, parseDeckText, typeGroup, validateDeck, type DeckCard } from './decks';

const info = (name: string, typeLine: string, manaCost: string, cmc: number, legalities: Record<string, string> = {}): DeckCard =>
  ({ name, typeLine, manaCost, cmc, image: null, legalities, anyNumber: false });

describe('deck text', () => {
  it('parses Arena/MTGO lists with set codes, x counts and a sideboard', () => {
    const r = parseDeckText('Deck\n4 Lightning Bolt (M10) 146\n20x Mountain\n\nSideboard\n2 Negate\nSB: 1 Shock\nbasura');
    expect(r.main).toEqual({ 'Lightning Bolt': 4, Mountain: 20 });
    expect(r.side).toEqual({ Negate: 2, Shock: 1 });
    expect(r.errors).toHaveLength(1);
  });

  it('round-trips through export', () => {
    const d = { ...newDeck(), main: { 'Lightning Bolt': 4 }, side: { Negate: 2 } };
    expect(parseDeckText(exportDeckText(d))).toMatchObject({ main: d.main, side: d.side });
  });
});

describe('deck validation', () => {
  const deck = () => ({
    ...newDeck(),
    main: { Mountain: 56, 'Lightning Bolt': 4 },
    info: { Mountain: info('Mountain', 'Basic Land — Mountain', '', 0, { modern: 'legal', standard: 'legal' }), 'Lightning Bolt': info('Lightning Bolt', 'Instant', '{R}', 1, { modern: 'legal', standard: 'not_legal' }) },
  });

  it('accepts 60 cards with any number of basic lands', () => {
    expect(validateDeck(deck(), CARDS)).toEqual({ errors: [], unplayable: [] });
  });

  it('enforces the copy limit, sideboard size and format legality', () => {
    const d = { ...deck(), main: { Mountain: 55, 'Lightning Bolt': 5 }, side: { Mountain: 16 } };
    expect(validateDeck(d, CARDS).errors.join(' ')).toMatch(/máximo es 4.*máximo es 15|máximo es 15.*máximo es 4/s);
    expect(validateDeck({ ...deck(), format: 'standard' }, CARDS).errors).toEqual(['Lightning Bolt no es legal en standard.']);
  });

  it('lists cards the engine cannot play yet', () => {
    const d = { ...deck(), main: { ...deck().main, 'Black Lotus': 1 } };
    expect(validateDeck(d, CARDS).unplayable).toEqual(['Black Lotus']);
  });
});

describe('deck stats', () => {
  const d = { ...newDeck(), main: { Forest: 20, 'Grizzly Bears': 4, 'Craw Wurm': 2, 'Boros Charm': 1 }, info: {
    Forest: info('Forest', 'Basic Land — Forest', '', 0), 'Grizzly Bears': info('Grizzly Bears', 'Creature — Bear', '{1}{G}', 2),
    'Craw Wurm': info('Craw Wurm', 'Creature — Wurm', '{4}{G}{G}', 6), 'Boros Charm': info('Boros Charm', 'Instant', '{R}{W}', 2),
  } };
  it('builds the mana curve without lands', () => { expect(manaCurve(d)).toEqual([0, 0, 5, 0, 0, 0, 2, 0]); });
  it('counts colored symbols', () => { expect(colorSymbols(d)).toEqual({ W: 1, U: 0, B: 0, R: 1, G: 8 }); });
  it('groups by type, a creature land as a land', () => {
    expect(typeGroup('Land Creature — Forest Dryad')).toBe('Tierras');
    expect(typeGroup('Legendary Planeswalker — Jace')).toBe('Planeswalkers');
  });
});
