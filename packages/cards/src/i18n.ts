import { ES } from './es';

/** A card face as printed in Spanish (from Scryfall). */
export interface EsCard { name: string; type: string; text: string; image: string | null }

/** The Spanish printing of a card face, if it has one; the engine keeps using the English Oracle name as its key. */
export const spanish = (name: string): EsCard | undefined => ES[name];

// Spanish names Scryfall's data lacks (tokens have no Spanish printing; some prints come without the translated name).
const KNOWN: Record<string, string> = { 'Lightning Bolt': 'Rayo', Soldier: 'Soldado' };

/** The name to show players: the Spanish printed name, or the English one if the card was never printed in Spanish. */
export const displayName = (name: string): string => KNOWN[name] ?? ES[name]?.name ?? name;
