import type { CardDef, CardRegistry } from '@mtg3d/engine';
import { DEFS } from './defs';

const registry = new Map(DEFS.map((d) => [d.name, d]));
export const CARDS: CardRegistry = registry;

/** Adds cards built from Oracle data (see oracle.ts); the hand-written definitions above always win. */
export function registerCards(defs: readonly CardDef[]): void {
  for (const d of defs) if (!registry.has(d.name)) registry.set(d.name, d);
}
export { KW_ES, compileOracle, type Compiled, type OracleCard } from './oracle';
export { DEFS };
export { PRESET_DECKS, validateCasualDeck } from './decks';
export { displayName, registerSpanish, spanish, type EsCard } from './i18n';
