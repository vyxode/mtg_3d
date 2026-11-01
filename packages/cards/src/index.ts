import type { CardRegistry } from '@mtg3d/engine';
import { DEFS } from './defs';

export const CARDS: CardRegistry = new Map(DEFS.map((d) => [d.name, d]));
export { DEFS };
export { PRESET_DECKS, validateCasualDeck } from './decks';
