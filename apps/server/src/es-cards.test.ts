import { describe, expect, it } from 'vitest';
import { entriesOf, type ScryCard } from './es-cards';

describe('Spanish printings', () => {
  it('keys each face by its English name and keeps the printed Spanish name, type, text and image', () => {
    const bolt: ScryCard = { lang: 'es', name: 'Lightning Bolt', printed_name: 'Rayo', printed_type_line: 'Instantáneo', printed_text: 'Rayo hace 3 puntos de daño a cualquier objetivo.', image_uris: { normal: 'https://cards.scryfall.io/normal/front/x.jpg' } };
    expect(entriesOf(bolt)).toEqual([['Lightning Bolt', { name: 'Rayo', type: 'Instantáneo', text: 'Rayo hace 3 puntos de daño a cualquier objetivo.', image: 'https://cards.scryfall.io/normal/front/x.jpg' }]]);
  });

  it('gives a double-faced card one entry per face, with each face image', () => {
    const dfc: ScryCard = {
      lang: 'es', name: 'Esper Origins // Summon: Esper Maduin',
      card_faces: [
        { name: 'Esper Origins', printed_name: 'Orígenes de Esper', image_uris: { normal: 'a.jpg' } },
        { name: 'Summon: Esper Maduin', printed_name: 'Invocación: Maduin de Esper', image_uris: { normal: 'b.jpg' } },
      ],
    };
    expect(entriesOf(dfc).map(([k, v]) => [k, v.name, v.image])).toEqual([
      ['Esper Origins', 'Orígenes de Esper', 'a.jpg'],
      ['Summon: Esper Maduin', 'Invocación: Maduin de Esper', 'b.jpg'],
    ]);
  });
});
