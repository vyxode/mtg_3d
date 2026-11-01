import { parseManaCost, type CardDef, type ManaType } from '@mtg3d/engine';

const basic = (name: string, subtype: string, produce: ManaType): CardDef => ({
  name, status: 'tested', manaCost: null, types: ['Land'], supertypes: ['Basic'], subtypes: [subtype],
  manaAbilities: [{ cost: 'tap', produce }], // 305.6: intrinsic mana ability of basic land types
});

// 'tested' means the card has its own scenario test, or it is a template with no rules text of its own
// (basic land, vanilla creature) whose template is tested.
const vanilla = (name: string, cost: string, subtypes: string[], power: number, toughness: number): CardDef => ({
  name, status: 'tested', manaCost: parseManaCost(cost), types: ['Creature'], subtypes, power, toughness,
});

/** Every card the engine can play. A card missing here is shown in the library but is not playable. */
export const DEFS: CardDef[] = [
  basic('Plains', 'Plains', 'W'),
  basic('Island', 'Island', 'U'),
  basic('Swamp', 'Swamp', 'B'),
  basic('Mountain', 'Mountain', 'R'),
  basic('Forest', 'Forest', 'G'),

  vanilla('Savannah Lions', '{W}', ['Cat'], 2, 1),
  vanilla('Coral Merfolk', '{1}{U}', ['Merfolk'], 2, 1),
  vanilla('Walking Corpse', '{1}{B}', ['Zombie'], 2, 2),
  vanilla('Grizzly Bears', '{1}{G}', ['Bear'], 2, 2),
  vanilla('Hill Giant', '{3}{R}', ['Giant'], 3, 3),
  vanilla('Craw Wurm', '{4}{G}{G}', ['Wurm'], 6, 4),
  vanilla('Merfolk of the Pearl Trident', '{U}', ['Merfolk'], 1, 1),
  vanilla('Pearled Unicorn', '{2}{W}', ['Unicorn'], 2, 2),
  vanilla('Gray Ogre', '{2}{R}', ['Ogre'], 2, 2),
  vanilla('Scathe Zombies', '{2}{B}', ['Zombie'], 2, 2),
  vanilla('Ironroot Treefolk', '{4}{G}', ['Treefolk'], 3, 5),
  {
    ...vanilla('Llanowar Elves', '{G}', ['Elf', 'Druid'], 1, 1),
    manaAbilities: [{ cost: 'tap', produce: 'G' }],
  },

  {
    name: 'Lightning Bolt', status: 'tested', manaCost: parseManaCost('{R}'), types: ['Instant'],
    spell: { targets: ['anyTarget'], effects: [{ kind: 'damage', amount: 3, target: 0 }] },
  },
  {
    name: 'Shock', status: 'tested', manaCost: parseManaCost('{R}'), types: ['Instant'],
    spell: { targets: ['anyTarget'], effects: [{ kind: 'damage', amount: 2, target: 0 }] },
  },
  {
    name: 'Counterspell', status: 'tested', manaCost: parseManaCost('{U}{U}'), types: ['Instant'],
    spell: { targets: ['spell'], effects: [{ kind: 'counter', target: 0 }] },
  },
  {
    name: 'Giant Growth', status: 'tested', manaCost: parseManaCost('{G}'), types: ['Instant'],
    spell: { targets: ['creature'], effects: [{ kind: 'pump', power: 3, toughness: 3, target: 0, duration: 'endOfTurn' }] },
  },
  {
    name: 'Divination', status: 'tested', manaCost: parseManaCost('{2}{U}'), types: ['Sorcery'],
    spell: { targets: [], effects: [{ kind: 'draw', amount: 2 }] },
  },
];
