import type { CardRegistry } from '@mtg3d/engine';

const expand = (list: [number, string][]): string[] => list.flatMap(([n, card]) => Array<string>(n).fill(card));

/** Ready-made 60-card decks built only from implemented cards, so a game can start without the deck builder. */
export const PRESET_DECKS: Record<string, string[]> = {
  'Naya (verde-rojo-blanco)': expand([
    [10, 'Forest'], [8, 'Mountain'], [6, 'Plains'],
    [4, 'Savannah Lions'], [4, 'Pearled Unicorn'], [4, 'Llanowar Elves'], [4, 'Grizzly Bears'], [4, 'Gray Ogre'],
    [4, 'Ironroot Treefolk'], [2, 'Hill Giant'], [2, 'Craw Wurm'], [4, 'Giant Growth'], [4, 'Lightning Bolt'],
  ]),
  'Grixis (azul-negro-rojo)': expand([
    [9, 'Island'], [8, 'Swamp'], [7, 'Mountain'],
    [4, 'Merfolk of the Pearl Trident'], [4, 'Coral Merfolk'], [4, 'Walking Corpse'], [4, 'Scathe Zombies'],
    [4, 'Gray Ogre'], [2, 'Hill Giant'], [4, 'Counterspell'], [2, 'Divination'], [4, 'Shock'], [4, 'Lightning Bolt'],
  ]),
  'Boros veloz (blanco-rojo)': expand([
    [12, 'Plains'], [12, 'Mountain'],
    [4, 'Savannah Lions'], [4, 'Youthful Knight'], [4, 'Fencing Ace'], [4, 'Raging Goblin'], [4, 'Highland Game'],
    [4, 'Boggart Brute'], [2, 'Serra Angel'], [4, 'Inspiring Overseer'], [2, 'Flametongue Kavu'], [4, 'Lightning Bolt'],
  ]),
  'Esper (blanco-azul-negro)': expand([
    [4, 'Hallowed Fountain'], [4, 'Watery Grave'], [4, 'Godless Shrine'], [5, 'Plains'], [3, 'Island'], [4, 'Swamp'],
    [4, "Ajani's Pridemate"], [2, 'Isamaru, Hound of Konda'], [4, 'Inspiring Overseer'], [4, 'Vampire Nighthawk'], [3, 'Typhoid Rats'],
    [3, 'Jace Beleren'], [4, 'Murder'], [3, 'Counterspell'], [4, 'Raise the Alarm'], [3, 'Glorious Anthem'], [2, 'Divination'],
  ]),
  // Built around the landfall cards of Standard's top deck (Mono-Green Landfall); the rest of that list is not implemented yet.
  'Landfall verde (base del meta)': expand([
    [14, 'Forest'], [4, 'Fabled Passage'], [4, 'Escape Tunnel'],
    [4, 'Llanowar Elves'], [4, "Sazh's Chocobo"], [4, 'Mossborn Hydra'], [4, 'Icetill Explorer'], [4, 'Elvish Visionary'],
    [4, 'Ironroot Treefolk'], [2, 'Colossal Dreadmaw'], [4, 'Shared Roots'], [2, 'Sapling Nursery'], [4, 'Giant Growth'], [2, 'Giant Spider'],
  ]),
  'Golgari (verde-negro)': expand([
    [13, 'Forest'], [11, 'Swamp'],
    [4, 'Llanowar Elves'], [4, 'Typhoid Rats'], [4, 'Elvish Visionary'], [4, 'Grizzly Bears'], [4, 'Vampire Nighthawk'],
    [4, 'Giant Spider'], [4, 'Colossal Dreadmaw'], [4, 'Walking Corpse'], [4, 'Giant Growth'],
  ]),
};

/**
 * Casual constructed (decision D5): at least 60 cards, at most 4 copies of a card except basic lands,
 * and in strict mode only implemented cards.
 * shortcut: lives here until the deck package (phase C) adds formats, sideboards and "any number" cards.
 */
export function validateCasualDeck(deck: readonly string[], reg: CardRegistry): string[] {
  const errors: string[] = [];
  if (deck.length < 60) errors.push(`El mazo tiene ${String(deck.length)} cartas; el mínimo es 60.`);
  const counts = new Map<string, number>();
  for (const name of deck) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [name, n] of counts) {
    const def = reg.get(name);
    if (!def || def.status === 'unsupported') { errors.push(`${name} todavía no está implementada.`); continue; }
    if (def.token) { errors.push(`${name} es una ficha y no puede ir en un mazo.`); continue; }
    if (n > 4 && !def.supertypes?.includes('Basic')) errors.push(`${name}: ${String(n)} copias; el máximo es 4.`);
  }
  return errors;
}
