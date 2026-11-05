import { describe, expect, it } from 'vitest';
import { compileOracle, type OracleCard } from './oracle';

// Invented cards worded with Magic's standard templates.
const card = (c: Partial<OracleCard> & { name: string; type_line: string }): OracleCard => ({ layout: 'normal', ...c });

describe('compileOracle', () => {
  it('reads a burn spell and a two-sentence spell', () => {
    const bolt = compileOracle(card({ name: 'Test Spark', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Test Spark deals 3 damage to any target.' }));
    expect(bolt.ok && bolt.def.spell).toEqual({ targets: ['anyTarget'], effects: [{ kind: 'damage', amount: 3, target: 0 }] });
    const both = compileOracle(card({ name: 'Test Insight', mana_cost: '{1}{U}', type_line: 'Sorcery', oracle_text: 'Draw two cards. You gain 2 life.' }));
    expect(both.ok && both.def.spell?.effects).toEqual([{ kind: 'draw', amount: 2 }, { kind: 'gainLife', amount: 2 }]);
  });

  it('reads keywords, an enters trigger with a target and a token', () => {
    const c = compileOracle(card({
      name: 'Test Warden', mana_cost: '{2}{W}', type_line: 'Creature — Human Soldier', power: '2', toughness: '3',
      oracle_text: 'Flying, vigilance\nWhen this creature enters, create a 1/1 white Spirit creature token with flying.',
    }));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.def.keywords).toEqual(['Flying', 'Vigilance']);
    expect(c.def.triggers?.[0]?.on).toBe('selfEntersBattlefield');
    expect(c.tokens[0]).toMatchObject({ types: ['Creature'], power: 1, toughness: 1, keywords: ['Flying'], token: true });
  });

  it('reads pronouns, activated abilities and lands with basic types', () => {
    const pump = compileOracle(card({ name: 'Test Growth', mana_cost: '{G}', type_line: 'Instant', oracle_text: 'Put a +1/+1 counter on target creature. It gains trample until end of turn.' }));
    expect(pump.ok && pump.def.spell?.effects).toEqual([{ kind: 'addCounters', target: 0, amount: 1 }, { kind: 'grant', ability: 'Trample', target: 0 }]);
    const pinger = compileOracle(card({ name: 'Test Pinger', mana_cost: '{1}{R}', type_line: 'Creature — Goblin', power: '1', toughness: '1', oracle_text: '{T}: Test Pinger deals 1 damage to any target.' }));
    expect(pinger.ok && pinger.def.activated?.[0]?.cost).toEqual({ tap: true });
    const dual = compileOracle(card({ name: 'Test Grove', type_line: 'Land — Forest Island', oracle_text: '({T}: Add {G} or {U}.)\nThis land enters tapped.' }));
    expect(dual.ok && dual.def.manaAbilities?.map((a) => a.produce)).toEqual([['G'], ['U']]);
    expect(dual.ok && dual.def.etb).toEqual({ tapped: true });
  });

  it('rejects any card with a line it does not understand', () => {
    const r = compileOracle(card({ name: 'Test Oddity', mana_cost: '{1}{U}', type_line: 'Creature — Wizard', power: '1', toughness: '1', oracle_text: 'Flying\nWhenever you cast a spell, scry 1.' }));
    expect(r).toEqual({ ok: false, reason: 'whenever you cast a spell, scry 1.' });
    expect(compileOracle(card({ name: 'Test X', mana_cost: '{X}{R}', type_line: 'Sorcery', oracle_text: 'Test X deals X damage to any target.' })).ok).toBe(false);
  });
});
