import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, searchCatalog, type RawCard } from './catalog';
import { parseBulkLine } from './sync-cards';
import { startServer, type RunningServer } from './server';

// Test data in the shape of Scryfall's bulk file: one object per line inside a JSON array.
const ids = { bolt: '11111111-1111-4111-8111-111111111111', bears: '22222222-2222-4222-8222-222222222222', delver: '33333333-3333-4333-8333-333333333333' };
const bulk = [
  '[',
  JSON.stringify({ id: 'a1', oracle_id: ids.bolt, name: 'Lightning Bolt', layout: 'normal', mana_cost: '{R}', cmc: 1, type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.', colors: ['R'], color_identity: ['R'], legalities: { modern: 'legal', standard: 'not_legal' }, set: 'lea', set_name: 'Limited Edition Alpha', collector_number: '161', rarity: 'common', released_at: '1993-08-05', image_uris: { normal: 'https://cards.scryfall.io/normal/a1.jpg' } }) + ',',
  JSON.stringify({ id: 'a2', oracle_id: ids.bolt, name: 'Lightning Bolt', layout: 'normal', mana_cost: '{R}', cmc: 1, type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.', colors: ['R'], color_identity: ['R'], legalities: { modern: 'legal' }, set: 'm10', set_name: 'Magic 2010', collector_number: '146', rarity: 'common', released_at: '2009-07-17', image_uris: { normal: 'https://cards.scryfall.io/normal/a2.jpg' } }) + ',',
  JSON.stringify({ id: 'a3', oracle_id: ids.bolt, name: 'Lightning Bolt', layout: 'normal', set: 'pz1', set_name: 'Digital', collector_number: '1', rarity: 'common', released_at: '2020-01-01', digital: true }) + ',',
  JSON.stringify({ id: 'b1', oracle_id: ids.bears, name: 'Grizzly Bears', layout: 'normal', mana_cost: '{1}{G}', cmc: 2, type_line: 'Creature — Bear', oracle_text: '', colors: ['G'], color_identity: ['G'], power: '2', toughness: '2', legalities: { modern: 'legal' }, set: 'lea', set_name: 'Limited Edition Alpha', collector_number: '198', rarity: 'common', released_at: '1993-08-05', image_uris: { normal: 'https://cards.scryfall.io/normal/b1.jpg' } }) + ',',
  JSON.stringify({ id: 'd1', oracle_id: ids.delver, name: 'Delver of Secrets // Insectile Aberration', layout: 'transform', cmc: 1, type_line: 'Creature — Human Wizard // Creature — Human Insect', color_identity: ['U'], legalities: { modern: 'legal' }, set: 'isd', set_name: 'Innistrad', collector_number: '51', rarity: 'common', released_at: '2011-09-30',
    card_faces: [
      { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature — Human Wizard', oracle_text: 'At the beginning of your upkeep, look at the top card of your library.', colors: ['U'], image_uris: { normal: 'https://cards.scryfall.io/normal/front/d1.jpg' } },
      { name: 'Insectile Aberration', mana_cost: '', type_line: 'Creature — Human Insect', oracle_text: 'Flying', colors: ['U'], image_uris: { normal: 'https://cards.scryfall.io/normal/back/d1.jpg' } },
    ] }),
  ']',
];
const catalog = buildCatalog(bulk.map(parseBulkLine).filter((c): c is RawCard => c !== null));

describe('catalog', () => {
  it('groups printings by Oracle card, newest first, and skips digital-only printings', () => {
    const bolt = catalog.find((c) => c.name === 'Lightning Bolt');
    expect(catalog).toHaveLength(3);
    expect(bolt?.printings.map((p) => p.set)).toEqual(['m10', 'lea']);
  });

  it('keeps both faces of a double-faced card with their own images', () => {
    const delver = catalog.find((c) => c.oracleId === ids.delver);
    expect(delver?.faces.map((f) => f.name)).toEqual(['Delver of Secrets', 'Insectile Aberration']);
    expect(delver?.manaCost).toBe('{U}');
    expect(delver?.printings[0]?.image).toBe('https://cards.scryfall.io/normal/front/d1.jpg');
  });

  it('searches by name (accent and case insensitive), type, color, mana value, stats, set and format', () => {
    const names = (q: Parameters<typeof searchCatalog>[1]) => searchCatalog(catalog, q).cards.map((c) => c.name);
    expect(names({ name: 'BOLT' })).toEqual(['Lightning Bolt']);
    expect(names({ type: 'creature' })).toHaveLength(2);
    expect(names({ colors: ['G'] })).toEqual(['Grizzly Bears']);
    expect(names({ cmc: 1, cmcOp: 'lte' })).toHaveLength(2);
    expect(names({ power: '2', toughness: '2' })).toEqual(['Grizzly Bears']);
    expect(names({ set: 'isd' })).toEqual(['Delver of Secrets // Insectile Aberration']);
    expect(names({ format: 'standard' })).toEqual([]);
    expect(names({ text: 'damage to any target' })).toEqual(['Lightning Bolt']);
  });
});

describe('catalog API', () => {
  let server: RunningServer;
  beforeAll(async () => { server = await startServer(0, [], null, { cards: catalog, sets: [], byId: new Map(catalog.map((c) => [c.oracleId, c])) }); });
  afterAll(async () => { await server.close(); });

  it('pages search results and trims printings in lists', async () => {
    const r = await (await fetch(`${server.url}/api/cards?name=bolt`)).json() as { total: number; cards: { printings: unknown[]; printingCount: number }[] };
    expect(r.total).toBe(1);
    expect(r.cards[0]?.printings).toHaveLength(1);
    expect(r.cards[0]?.printingCount).toBe(2);
  });

  it('returns every printing in the detail view and 404 for unknown ids', async () => {
    const card = await (await fetch(`${server.url}/api/cards/${ids.bolt}`)).json() as { printings: unknown[] };
    expect(card.printings).toHaveLength(2);
    expect((await fetch(`${server.url}/api/cards/${ids.bolt.replace('1', '9')}`)).status).toBe(404);
  });

  it('rejects invalid parameters', async () => {
    expect((await fetch(`${server.url}/api/cards?cmc=abc`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/cards?rarity=legendary`)).status).toBe(400);
  });
});
