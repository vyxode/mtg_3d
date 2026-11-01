import { parseManaCost, type CardDef, type ManaType } from '@mtg3d/engine';

const basic = (name: string, subtype: string, produce: ManaType): CardDef => ({
  name, status: 'tested', manaCost: null, types: ['Land'], supertypes: ['Basic'], subtypes: [subtype],
  manaAbilities: [{ cost: 'tap', produce: [produce] }], // 305.6: intrinsic mana ability of basic land types
});

// 'tested' means the card has its own scenario test, or it is a template with no rules text of its own
// (basic land, vanilla creature) whose template is tested.
const vanilla = (name: string, cost: string, subtypes: string[], power: number, toughness: number): CardDef => ({
  name, status: 'tested', manaCost: parseManaCost(cost), types: ['Creature'], subtypes, power, toughness,
});

/** Shock lands: "({T}: Add {X} or {Y}.) As this land enters, you may pay 2 life. If you don't, it enters tapped." */
const shock = (name: string, types: [string, string], produce: [ManaType, ManaType]): CardDef => ({
  name, status: 'tested', manaCost: null, types: ['Land'], subtypes: types,
  manaAbilities: [{ cost: 'tap', produce }], etb: { tappedUnlessPayLife: 2 },
});

const creature = (name: string, cost: string, subtypes: string[], power: number, toughness: number, extra: Partial<CardDef>): CardDef => ({
  ...vanilla(name, cost, subtypes, power, toughness), ...extra,
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
    manaAbilities: [{ cost: 'tap', produce: ['G'] }],
  },

  // Keyword abilities (702)
  creature('Wind Drake', '{2}{U}', ['Drake'], 2, 2, { keywords: ['Flying'] }),
  creature('Giant Spider', '{3}{G}', ['Spider'], 2, 4, { keywords: ['Reach'] }),
  creature('Serra Angel', '{3}{W}{W}', ['Angel'], 4, 4, { keywords: ['Flying', 'Vigilance'] }),
  creature('Raging Goblin', '{R}', ['Goblin', 'Berserker'], 1, 1, { keywords: ['Haste'] }),
  creature('Wall of Stone', '{1}{R}{R}', ['Wall'], 0, 8, { keywords: ['Defender'] }),
  creature('Boggart Brute', '{2}{R}', ['Goblin', 'Warrior'], 3, 2, { keywords: ['Menace'] }),
  creature('Youthful Knight', '{1}{W}', ['Human', 'Knight'], 2, 1, { keywords: ['First strike'] }),
  creature('Fencing Ace', '{1}{W}', ['Human', 'Soldier'], 1, 1, { keywords: ['Double strike'] }),
  creature('Typhoid Rats', '{B}', ['Rat'], 1, 1, { keywords: ['Deathtouch'] }),
  creature('Colossal Dreadmaw', '{4}{G}{G}', ['Dinosaur'], 6, 6, { keywords: ['Trample'] }),
  creature('Vampire Nighthawk', '{1}{B}{B}', ['Vampire', 'Shaman'], 2, 3, { keywords: ['Flying', 'Deathtouch', 'Lifelink'] }),
  creature('Darksteel Myr', '{3}', ['Myr'], 0, 1, { types: ['Artifact', 'Creature'], keywords: ['Indestructible'] }),

  // Triggered abilities (603)
  creature('Elvish Visionary', '{1}{G}', ['Elf', 'Shaman'], 1, 1, {
    triggers: [{ on: 'selfEntersBattlefield', targets: [], effects: [{ kind: 'draw', amount: 1 }] }],
  }),
  creature('Highland Game', '{1}{R}', ['Elk'], 2, 1, {
    triggers: [{ on: 'selfDies', targets: [], effects: [{ kind: 'gainLife', amount: 2 }] }],
  }),
  creature('Flametongue Kavu', '{3}{R}', ['Kavu'], 4, 2, {
    triggers: [{ on: 'selfEntersBattlefield', targets: ['creature'], effects: [{ kind: 'damage', amount: 4, target: 0 }] }],
  }),
  creature('Inspiring Overseer', '{2}{W}', ['Angel', 'Cleric'], 2, 1, {
    keywords: ['Flying'],
    triggers: [{ on: 'selfEntersBattlefield', targets: [], effects: [{ kind: 'gainLife', amount: 1 }, { kind: 'draw', amount: 1 }] }],
  }),

  // Statics, activated abilities, tokens, counters, destroy, legend rule (D2b)
  {
    name: 'Glorious Anthem', status: 'tested', manaCost: parseManaCost('{1}{W}{W}'), types: ['Enchantment'],
    statics: [{ kind: 'anthem', affects: 'creaturesYouControl', power: 1, toughness: 1 }],
  },
  creature('Benalish Marshal', '{W}{W}{W}', ['Human', 'Knight'], 3, 3, {
    statics: [{ kind: 'anthem', affects: 'otherCreaturesYouControl', power: 1, toughness: 1 }],
  }),
  creature('Prodigal Pyromancer', '{2}{R}', ['Human', 'Wizard'], 1, 1, {
    activated: [{ text: '{T}: 1 de daño a cualquier objetivo', cost: { tap: true }, targets: ['anyTarget'], effects: [{ kind: 'damage', amount: 1, target: 0 }] }],
  }),
  creature("Ajani's Pridemate", '{1}{W}', ['Cat', 'Soldier'], 2, 2, {
    triggers: [{ on: 'controllerGainsLife', targets: [], effects: [{ kind: 'addCounters', target: 'self', amount: 1 }] }],
  }),
  creature('Isamaru, Hound of Konda', '{W}', ['Dog'], 2, 2, { supertypes: ['Legendary'] }),
  {
    name: 'Murder', status: 'tested', manaCost: parseManaCost('{1}{B}{B}'), types: ['Instant'],
    spell: { targets: ['creature'], effects: [{ kind: 'destroy', target: 0 }] },
  },
  {
    name: 'Raise the Alarm', status: 'tested', manaCost: parseManaCost('{1}{W}'), types: ['Instant'],
    spell: { targets: [], effects: [{ kind: 'createToken', token: 'Soldier', amount: 2 }] },
  },
  { name: 'Soldier', status: 'tested', manaCost: null, types: ['Creature'], subtypes: ['Soldier'], power: 1, toughness: 1, token: true },

  {
    name: 'Jace Beleren', status: 'tested', manaCost: parseManaCost('{1}{U}{U}'), types: ['Planeswalker'],
    supertypes: ['Legendary'], subtypes: ['Jace'], loyalty: 3,
    activated: [
      { text: '+2: Cada jugador roba una carta', cost: { loyalty: 2 }, targets: [], effects: [{ kind: 'drawEach', amount: 1 }] },
      { text: '−1: El jugador objetivo roba una carta', cost: { loyalty: -1 }, targets: ['player'], effects: [{ kind: 'targetDraws', target: 0, amount: 1 }] },
      { text: '−10: El jugador objetivo muele veinte cartas', cost: { loyalty: -10 }, targets: ['player'], effects: [{ kind: 'mill', target: 0, amount: 20 }] },
    ],
  },

  shock('Hallowed Fountain', ['Plains', 'Island'], ['W', 'U']),
  shock('Watery Grave', ['Island', 'Swamp'], ['U', 'B']),
  shock('Blood Crypt', ['Swamp', 'Mountain'], ['B', 'R']),
  shock('Stomping Ground', ['Mountain', 'Forest'], ['R', 'G']),
  shock('Temple Garden', ['Forest', 'Plains'], ['G', 'W']),
  shock('Godless Shrine', ['Plains', 'Swamp'], ['W', 'B']),
  shock('Steam Vents', ['Island', 'Mountain'], ['U', 'R']),
  shock('Overgrown Tomb', ['Swamp', 'Forest'], ['B', 'G']),
  shock('Sacred Foundry', ['Mountain', 'Plains'], ['R', 'W']),
  shock('Breeding Pool', ['Forest', 'Island'], ['G', 'U']),

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
