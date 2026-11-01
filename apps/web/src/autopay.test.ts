import { describe, expect, it } from 'vitest';
import { parseManaCost, viewFor } from '@mtg3d/engine';
import { scenario } from '@mtg3d/engine/testing';
import { CARDS } from '@mtg3d/cards';
import { autopay } from './autopay';

const setup = (battlefield: string[]) => {
  const s = scenario(CARDS, { p1: { battlefield } });
  const view = viewFor(s, CARDS, 'p1');
  return { view, sources: view.zones.battlefield };
};

describe('autopay', () => {
  it('covers colored symbols with matching sources and generic with the rest', () => {
    const { view, sources } = setup(['Island', 'Island', 'Mountain']);
    const paid = autopay(view, CARDS, sources, parseManaCost('{1}{U}{U}'));
    expect(paid).toHaveLength(3);
  });

  it('returns null when a color is missing', () => {
    const { view, sources } = setup(['Mountain', 'Mountain']);
    expect(autopay(view, CARDS, sources, parseManaCost('{U}'))).toBeNull();
  });

  it('prefers lands over mana creatures for generic mana', () => {
    const { view, sources } = setup(['Llanowar Elves', 'Forest', 'Forest']);
    const paid = autopay(view, CARDS, sources, parseManaCost('{1}{G}')) ?? [];
    expect(paid.map((id) => view.objects[id]?.card)).toEqual(['Forest', 'Forest']);
  });
});
