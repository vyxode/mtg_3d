import { describe, expect, it } from 'vitest';
import { CARDS } from '@mtg3d/cards';
import { viewFor } from '@mtg3d/engine';
import { scenario } from '@mtg3d/engine/testing';
import { CARD_W, layoutTable, spread } from './layout';

const board = () => scenario(CARDS, {
  p1: { hand: ['Lightning Bolt', 'Forest'], battlefield: ['Grizzly Bears', { card: 'Mountain', tapped: true }], library: ['Forest', 'Forest'] },
  p2: { hand: ['Shock', 'Shock', 'Shock'], battlefield: ['Hill Giant'], graveyard: ['Shock'] },
});
const byCard = (pl: ReturnType<typeof layoutTable>, card: string) => pl.filter((p) => p.card === card);

describe('table layout', () => {
  it('seats the viewer at +z and shows only what the viewer may see', () => {
    const pl = layoutTable(viewFor(board(), CARDS, 'p1'));
    expect(byCard(pl, 'Grizzly Bears')[0]?.z).toBeGreaterThan(0);
    expect(byCard(pl, 'Hill Giant')[0]?.z).toBeLessThan(0);
    expect(byCard(pl, 'Lightning Bolt')[0]?.tilt).toBeGreaterThan(0);
    expect(pl.filter((p) => p.key.startsWith('hand-p2'))).toHaveLength(3);
    expect(pl.filter((p) => p.key.startsWith('hand-p2')).every((p) => p.card === null)).toBe(true);
    expect(pl.find((p) => p.key === 'library-p1')?.badges).toEqual(['biblioteca 2']);
    expect(byCard(pl, 'Shock')[0]?.badges).toEqual(['cementerio 1']);
  });

  it('turns tapped cards and the opponent\'s cards', () => {
    const pl = layoutTable(viewFor(board(), CARDS, 'p1'));
    expect(byCard(pl, 'Mountain')[0]?.yaw).toBeCloseTo(-Math.PI / 2);
    expect(byCard(pl, 'Hill Giant')[0]?.yaw).toBeCloseTo(Math.PI);
    expect(byCard(pl, 'Grizzly Bears')[0]?.badges).toEqual(['2/2']);
  });

  it('moves attackers to the middle and puts each blocker in front of its attacker', () => {
    const s = board();
    const bear = s.zones.battlefield.find((id) => s.objects[id]?.card === 'Grizzly Bears') as string;
    const giant = s.zones.battlefield.find((id) => s.objects[id]?.card === 'Hill Giant') as string;
    s.combat = { attackers: [{ id: bear, defending: 'p2' }], blocks: [{ blocker: giant, attacker: bear }], assignments: {}, damageStep: null, firstStrikers: [] };
    const pl = layoutTable(viewFor(s, CARDS, 'p1'));
    const b = pl.find((p) => p.key === bear);
    const g = pl.find((p) => p.key === giant);
    expect(b?.highlight).toBe('attacking');
    expect(g?.highlight).toBe('blocking');
    expect(b?.z).toBeLessThan(3);
    expect(g?.x).toBeCloseTo(b?.x ?? NaN);
    expect(g?.z).toBeLessThan(b?.z ?? NaN);
  });

  it('marks the cards the viewer can use now', () => {
    const s = board();
    const bolt = s.zones.hand.p1.find((id) => s.objects[id]?.card === 'Lightning Bolt') as string;
    expect(layoutTable(viewFor(s, CARDS, 'p1'), new Set([bolt])).find((p) => p.key === bolt)?.highlight).toBe('playable');
    expect(layoutTable(viewFor(s, CARDS, 'p1')).some((p) => p.highlight === 'playable')).toBe(false);
  });

  it('spreads cards without overlap until the row is full, then overlaps evenly', () => {
    const few = spread(3);
    expect((few[1] ?? 0) - (few[0] ?? 0)).toBeGreaterThanOrEqual(CARD_W);
    const many = spread(30, 22);
    expect((many[29] ?? 0) - (many[0] ?? 0)).toBeCloseTo(22 - CARD_W);
  });
});
