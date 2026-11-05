import { describe, expect, it } from 'vitest';
import { buildOracleDefs } from './oracle-cards';

describe('buildOracleDefs', () => {
  it('keeps playable paper cards and the tokens they make, and skips joke and digital cards', () => {
    const base = { layout: 'normal', games: ['paper'], legalities: { commander: 'legal' } };
    const { defs, tried } = buildOracleDefs([
      { ...base, name: 'Test Call', mana_cost: '{2}{W}', type_line: 'Sorcery', oracle_text: 'Create two 1/1 white Soldier creature tokens.' },
      { ...base, name: 'Test Joke', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Draw a card.', set_type: 'funny' },
      { ...base, name: 'Test Online', mana_cost: '{U}', type_line: 'Instant', oracle_text: 'Draw a card.', digital: true },
      { ...base, name: 'Test Mystery', mana_cost: '{U}', type_line: 'Instant', oracle_text: 'Do something unusual.' },
    ]);
    expect(tried).toBe(2);
    expect(defs.map((d) => d.name)).toEqual(['Test Call', 'Soldier 1/1W']);
  });
});
