import { parseManaCost } from '@mtg3d/engine';
import type { ActivatedDef, CardDef, CardType, Effect, GrantedAbility, Keyword, ManaType, StaticDef, TargetSpec, TriggerDef } from '@mtg3d/engine';

/**
 * Builds engine definitions from a card's Oracle data (as Scryfall publishes it), reusing the effects the engine already
 * implements. A card is accepted only if every line of its rules text is understood; anything else is rejected with the
 * line that could not be read, so a card is never played with a wrong or missing effect.
 */
export interface OracleCard {
  name: string;
  layout: string;
  mana_cost?: string;
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
}

export type Compiled = { ok: true; def: CardDef; tokens: CardDef[] } | { ok: false; reason: string };

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (w: string): number | null => (/^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] ?? null);

const KEYWORDS: Record<string, Keyword> = {
  flying: 'Flying', reach: 'Reach', vigilance: 'Vigilance', haste: 'Haste', defender: 'Defender', menace: 'Menace',
  'first strike': 'First strike', 'double strike': 'Double strike', deathtouch: 'Deathtouch', trample: 'Trample',
  lifelink: 'Lifelink', indestructible: 'Indestructible', flash: 'Flash',
};

const TARGETS: [RegExp, TargetSpec][] = [
  [/^any target$/, 'anyTarget'],
  [/^target creature you control$/, 'creatureYouControl'],
  [/^target creature (?:an opponent controls|you don't control)$/, 'creatureOpponentControls'],
  [/^target creature or planeswalker$/, 'creatureOrPlaneswalker'],
  [/^target creature$/, 'creature'],
  [/^target player$/, 'player'],
  [/^target opponent$/, 'opponent'],
  [/^target planeswalker$/, 'planeswalker'],
  [/^target artifact or enchantment$/, 'artifactOrEnchantment'],
  [/^target artifact$/, 'artifact'],
  [/^target enchantment$/, 'enchantment'],
  [/^target nonland permanent$/, 'nonlandPermanent'],
  [/^target permanent$/, 'permanent'],
  [/^target nonbasic land$/, 'nonbasicLand'],
  [/^target land$/, 'land'],
  [/^target spell$/, 'spell'],
  [/^target card from a graveyard$/, 'cardInGraveyard'],
];

const SUPERTYPES = new Set(['Basic', 'Legendary', 'Snow']);
const TYPES = new Set<string>(['Land', 'Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker']);
const COLORS: Record<string, ManaType> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/** Reads the sentences of one ability; targets are appended to `targets` and referred to by index. */
class Reader {
  constructor(readonly targets: TargetSpec[], readonly tokens: CardDef[]) {}
  private last = -1;

  /** A target phrase, "it" (the last target) or "~" (the source itself). */
  private target(phrase: string): number | 'self' | null {
    if (phrase === 'it' || phrase === 'that creature') return this.last >= 0 ? this.last : null;
    if (phrase === '~') return 'self';
    const spec = TARGETS.find(([re]) => re.test(phrase))?.[1];
    if (!spec) return null;
    this.targets.push(spec);
    this.last = this.targets.length - 1;
    return this.last;
  }

  private objectTarget(phrase: string): number | null {
    const t = this.target(phrase);
    return typeof t === 'number' ? t : null;
  }

  private grants(list: string): GrantedAbility[] | null {
    const out: GrantedAbility[] = [];
    for (const k of list.split(/, and |, | and /)) {
      if (k === "can't be blocked this turn" || k === "can't be blocked") { out.push('cantBeBlocked'); continue; }
      const kw = KEYWORDS[k];
      if (!kw) return null;
      out.push(kw);
    }
    return out;
  }

  private token(m: RegExpMatchArray): Effect | null {
    const [, count = '', p = '', t = '', colorWords = '', subtypeWords = '', kwText] = m;
    const amount = num(count);
    const colors = colorWords.split(/ and |, /).map((c) => (c === 'colorless' ? null : COLORS[c]));
    if (amount === null || colors.some((c) => c === undefined)) return null;
    const keywords = kwText ? kwText.split(/, and |, | and /).map((k) => KEYWORDS[k]) : [];
    if (keywords.some((k) => k === undefined)) return null;
    const subtypes = subtypeWords.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    const name = `${subtypes.join(' ')} ${p}/${t}${colors.filter(Boolean).join('')}${keywords.length ? ` (${keywords.join(', ')})` : ''}`;
    if (!this.tokens.some((d) => d.name === name)) {
      this.tokens.push({
        name, status: 'implemented', manaCost: null, types: ['Creature'], subtypes, power: Number(p), toughness: Number(t), token: true,
        ...(keywords.length > 0 && { keywords: keywords as Keyword[] }),
      });
    }
    return { kind: 'createToken', token: name, amount };
  }

  /** One sentence (lower case, no final period) into effects, or null if it is not understood. */
  sentence(s: string): Effect[] | null {
    let m: RegExpMatchArray | null;
    if ((m = /^~ deals (\w+) damage to (.+)$/.exec(s))) {
      const amount = num(m[1] ?? ''); const t = this.objectTarget(m[2] ?? '');
      return amount === null || t === null ? null : [{ kind: 'damage', amount, target: t }];
    }
    if ((m = /^draw (\w+) cards?$/.exec(s))) { const n = num(m[1] ?? ''); return n === null ? null : [{ kind: 'draw', amount: n }]; }
    if ((m = /^each player draws (\w+) cards?$/.exec(s))) { const n = num(m[1] ?? ''); return n === null ? null : [{ kind: 'drawEach', amount: n }]; }
    if ((m = /^(target (?:player|opponent)) draws (\w+) cards?$/.exec(s))) {
      const t = this.objectTarget(m[1] ?? ''); const n = num(m[2] ?? '');
      return t === null || n === null ? null : [{ kind: 'targetDraws', target: t, amount: n }];
    }
    if ((m = /^you gain (\w+) life$/.exec(s))) { const n = num(m[1] ?? ''); return n === null ? null : [{ kind: 'gainLife', amount: n }]; }
    if ((m = /^destroy (.+)$/.exec(s))) { const t = this.objectTarget(m[1] ?? ''); return t === null ? null : [{ kind: 'destroy', target: t }]; }
    if ((m = /^exile (.+)$/.exec(s))) { const t = this.objectTarget(m[1] ?? ''); return t === null ? null : [{ kind: 'exileTarget', target: t }]; }
    if ((m = /^counter (target spell)$/.exec(s))) { const t = this.objectTarget(m[1] ?? ''); return t === null ? null : [{ kind: 'counter', target: t }]; }
    if ((m = /^(.+?) gets \+(\d+)\/\+(\d+)(?: and gains (.+?))? until end of turn$/.exec(s))) {
      const t = this.objectTarget(m[1] ?? '');
      const extra = m[4] ? this.grants(m[4]) : [];
      if (t === null || extra === null) return null;
      return [{ kind: 'pump', power: Number(m[2]), toughness: Number(m[3]), target: t, duration: 'endOfTurn' }, ...extra.map((ability): Effect => ({ kind: 'grant', ability, target: t }))];
    }
    if ((m = /^(.+?) gains (.+?) until end of turn$/.exec(s))) {
      const t = this.objectTarget(m[1] ?? ''); const g = this.grants(m[2] ?? '');
      return t === null || g === null ? null : g.map((ability): Effect => ({ kind: 'grant', ability, target: t }));
    }
    if ((m = /^put (\w+) \+1\/\+1 counters? on (.+)$/.exec(s))) {
      const n = num(m[1] ?? ''); const t = this.target(m[2] ?? '');
      return n === null || t === null ? null : [{ kind: 'addCounters', target: t, amount: n }];
    }
    if ((m = /^create (\w+) (\d+)\/(\d+) ((?:white|blue|black|red|green|colorless)(?:(?:, | and )(?:white|blue|black|red|green))*) ([a-z ]+?) creature tokens?(?: with (.+))?$/.exec(s))) {
      const e = this.token(m); return e ? [e] : null;
    }
    if ((m = /^surveil (\w+)$/.exec(s))) { const n = num(m[1] ?? ''); return n === null ? null : [{ kind: 'surveil', amount: n }]; }
    if ((m = /^mill (\w+) cards?$/.exec(s))) { const n = num(m[1] ?? ''); return n === null ? null : [{ kind: 'mill', target: 'you', amount: n }]; }
    if ((m = /^(target (?:player|opponent)) mills (\w+) cards?$/.exec(s))) {
      const t = this.objectTarget(m[1] ?? ''); const n = num(m[2] ?? '');
      return t === null || n === null ? null : [{ kind: 'mill', target: t, amount: n }];
    }
    if ((m = /^search your library for a basic land card, put it onto the battlefield( tapped)?, then shuffle$/.exec(s))) {
      return [{ kind: 'searchBasicLand', tapped: m[1] !== undefined }];
    }
    return null;
  }

  /** Several sentences: "Draw a card. You gain 2 life." */
  effects(text: string): Effect[] | null {
    const out: Effect[] = [];
    for (const raw of text.split(/\.(?:\s+|$)/)) {
      const s = raw.trim();
      if (!s) continue;
      const e = this.sentence(s);
      if (!e) return null;
      out.push(...e);
    }
    return out.length > 0 ? out : null;
  }
}

function manaAbility(line: string): ManaType[] | null {
  if (line === '{t}: add one mana of any color.') return ['W', 'U', 'B', 'R', 'G'];
  const m = /^\{t\}: add ((?:\{[wubrgc]\})(?:(?:, | or |, or )\{[wubrgc]\})*)\.$/.exec(line);
  if (!m) return null;
  return [...(m[1] ?? '').matchAll(/\{([wubrgc])\}/g)].map((x) => (x[1] ?? '').toUpperCase() as ManaType);
}

const TRIGGERS: [RegExp, TriggerDef['on']][] = [
  [/^when ~ enters(?: the battlefield)?, (.+)$/, 'selfEntersBattlefield'],
  [/^when ~ dies, (.+)$/, 'selfDies'],
  [/^whenever ~ attacks, (.+)$/, 'selfAttacks'],
  [/^whenever you gain life, (.+)$/, 'controllerGainsLife'],
  [/^(?:landfall — )?whenever a land you control enters(?: the battlefield)?(?: under your control)?, (.+)$/, 'landYouControlEnters'],
];

const SPEC_ES: Record<TargetSpec, string> = {
  anyTarget: 'cualquier objetivo', creature: 'criatura objetivo', spell: 'hechizo objetivo', player: 'jugador objetivo', creatureYouControl: 'criatura objetivo que controles',
  creaturePowerAtMost2: 'criatura objetivo con fuerza 2 o menos', landYouControl: 'tierra objetivo que controles', creatureOpponentControls: 'criatura objetivo de un oponente',
  nonbasicLandOpponentControls: 'tierra no básica objetivo de un oponente', cardInGraveyard: 'carta objetivo de un cementerio', permanent: 'permanente objetivo',
  nonlandPermanent: 'permanente objetivo que no sea tierra', artifact: 'artefacto objetivo', enchantment: 'encantamiento objetivo', artifactOrEnchantment: 'artefacto o encantamiento objetivo',
  planeswalker: 'planeswalker objetivo', creatureOrPlaneswalker: 'criatura o planeswalker objetivo', land: 'tierra objetivo', nonbasicLand: 'tierra no básica objetivo', opponent: 'oponente objetivo',
};
/** Spanish names of keywords (and granted abilities), as printed on Spanish cards. */
export const KW_ES: Record<string, string> = {
  Flying: 'vuela', Reach: 'alcance', Vigilance: 'vigilancia', Haste: 'prisa', Defender: 'defensor', Menace: 'amenaza', 'First strike': 'dañar primero',
  'Double strike': 'dañar dos veces', Deathtouch: 'toque mortal', Trample: 'arrollar', Lifelink: 'vínculo vital', Indestructible: 'indestructible', Flash: 'destello',
  cantBeBlocked: 'no puede ser bloqueada',
};

/** A short Spanish description of what an ability does, built from its effects (shown on its button). */
export function describe(effects: readonly Effect[], targets: readonly TargetSpec[]): string {
  const t = (i: number | 'self' | 'you') => (typeof i === 'number' ? SPEC_ES[targets[i] ?? 'anyTarget'] : i === 'self' ? 'esta carta' : 'ti');
  return effects.map((e): string => {
    switch (e.kind) {
      case 'damage': return `${String(e.amount)} de daño a ${t(e.target)}`;
      case 'draw': return e.amount === 1 ? 'roba una carta' : `roba ${String(e.amount)} cartas`;
      case 'drawEach': return `cada jugador roba ${String(e.amount)}`;
      case 'targetDraws': return `${t(e.target)} roba ${String(e.amount)}`;
      case 'gainLife': return `ganas ${String(e.amount)} vidas`;
      case 'destroy': return `destruye ${t(e.target)}`;
      case 'exileTarget': return `exilia ${t(e.target)}`;
      case 'counter': return `contrarresta ${t(e.target)}`;
      case 'pump': return `${t(e.target)} obtiene ${e.power >= 0 ? '+' : ''}${String(e.power)}/${e.toughness >= 0 ? '+' : ''}${String(e.toughness)} hasta el final del turno`;
      case 'grant': return `${t(e.target)} gana ${KW_ES[e.ability] ?? e.ability} hasta el final del turno`;
      case 'addCounters': return `${String(e.amount)} contador${e.amount === 1 ? '' : 'es'} +1/+1 en ${t(e.target)}`;
      case 'createToken': return `crea ${String(e.amount)} ficha${e.amount === 1 ? '' : 's'} ${e.token}`;
      case 'surveil': return `vigila ${String(e.amount)}`;
      case 'mill': return `${t(e.target)} muele ${String(e.amount)}`;
      case 'searchBasicLand': return 'busca una tierra básica';
      default: return e.kind;
    }
  }).join('; ');
}

export function compileOracle(card: OracleCard): Compiled {
  const no = (reason: string): Compiled => ({ ok: false, reason });
  if (card.layout !== 'normal') return no(`layout ${card.layout}`);
  const [left = '', right = ''] = card.type_line.split(' — ');
  const words = left.split(' ');
  if (words.some((w) => !SUPERTYPES.has(w) && !TYPES.has(w))) return no(`type ${left}`);
  const types = words.filter((w) => TYPES.has(w)) as CardType[];
  const supertypes = words.filter((w): w is 'Basic' | 'Legendary' => w === 'Basic' || w === 'Legendary');
  let manaCost: CardDef['manaCost'];
  try { manaCost = card.mana_cost ? parseManaCost(card.mana_cost) : null; } catch { return no(`cost ${card.mana_cost ?? ''}`); }
  if (!card.mana_cost && !types.includes('Land')) return no('no mana cost');

  const def: CardDef = { name: card.name, status: 'implemented', manaCost, types };
  if (supertypes.length) def.supertypes = supertypes;
  if (right) def.subtypes = right.split(' ');
  if (types.includes('Creature')) {
    if (!/^\d+$/.test(card.power ?? '') || !/^\d+$/.test(card.toughness ?? '')) return no('variable power or toughness');
    def.power = Number(card.power); def.toughness = Number(card.toughness);
  }
  if (types.includes('Planeswalker')) return no('planeswalker');

  // The card's own name (and the short name of a legend, "Name, the Title") reads as "~".
  const short = card.name.split(',')[0] ?? card.name;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = (card.oracle_text ?? '')
    .replace(/\s*\([^)]*\)/g, '') // reminder text
    .replace(new RegExp(esc(card.name), 'g'), '~').replace(new RegExp(`\\b${esc(short)}\\b`, 'g'), '~')
    .replace(/\bthis (?:creature|spell|artifact|enchantment|land|card)\b/gi, '~')
    .toLowerCase();

  const tokens: CardDef[] = [];
  const keywords: Keyword[] = [];
  const triggers: TriggerDef[] = [];
  const activated: ActivatedDef[] = [];
  const statics: StaticDef[] = [];
  const spellTargets: TargetSpec[] = [];
  const spellEffects: Effect[] = [];
  const isSpell = types.includes('Instant') || types.includes('Sorcery');

  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    // Basic land types give their mana ability by themselves (305.6); the line is only reminder text.
    const kws = line.replace(/\.$/, '').split(/, /).map((k) => KEYWORDS[k]);
    if (kws.every((k) => k !== undefined)) { keywords.push(...kws); continue; }
    const mana = manaAbility(line);
    if (mana) { (def.manaAbilities ??= []).push({ cost: 'tap', produce: mana }); continue; }
    if (line === '~ enters tapped.' || line === '~ enters the battlefield tapped.') { def.etb = { tapped: true }; continue; }
    if (line === "~ can't be countered." || line === "this spell can't be countered.") { def.cantBeCountered = true; continue; }
    let m: RegExpMatchArray | null;
    if ((m = /^~ enters(?: the battlefield)? with (\w+) \+1\/\+1 counters? on it\.$/.exec(line)) && num(m[1] ?? '')) { def.entersWithCounters = num(m[1] ?? '') ?? 0; continue; }
    if (line === 'you may play an additional land on each of your turns.') { statics.push({ kind: 'extraLandDrop' }); continue; }
    if ((m = /^(other )?creatures you control get \+(\d+)\/\+(\d+)\.$/.exec(line))) {
      statics.push({ kind: 'anthem', affects: m[1] ? 'otherCreaturesYouControl' : 'creaturesYouControl', power: Number(m[2]), toughness: Number(m[3]) });
      continue;
    }
    if (line === 'enchant creature') { def.enchant = 'creature'; continue; }
    if ((m = /^enchanted creature gets \+(\d+)\/\+(\d+)\.$/.exec(line)) && def.enchant) { statics.push({ kind: 'enchantedGets', power: Number(m[1]), toughness: Number(m[2]) }); continue; }

    const trig = TRIGGERS.map(([re, on]) => [re.exec(line.replace(/\.$/, '')), on] as const).find(([x]) => x);
    if (trig) {
      const targets: TargetSpec[] = [];
      const effects = new Reader(targets, tokens).effects(trig[0]?.[1] ?? '');
      if (!effects) return no(line);
      triggers.push({ on: trig[1], targets, effects });
      continue;
    }
    // "[cost]: [effect]" with mana, {T} and "sacrifice ~" in the cost.
    if ((m = /^((?:\{[0-9wubrgc]+\})*)((?:,? ?\{t\})?)((?:, sacrifice ~)?): (.+)$/.exec(line)) && (m[1] || m[2])) {
      const targets: TargetSpec[] = [];
      const body = m[4] ?? '';
      const sorcery = body.endsWith(' activate only as a sorcery.');
      const effects = new Reader(targets, tokens).effects(sorcery ? body.slice(0, -' activate only as a sorcery.'.length) : body);
      if (!effects) return no(line);
      let mc;
      try { mc = m[1] ? parseManaCost((m[1]).toUpperCase()) : undefined; } catch { return no(line); }
      activated.push({
        text: `${[(m[1] ?? '').toUpperCase(), m[2] ? '{T}' : '', m[3] ? 'sacrifícala' : ''].filter(Boolean).join(', ')}: ${describe(effects, targets)}`, targets, effects,
        cost: { ...(mc && { mana: mc }), ...(m[2] && { tap: true }), ...(m[3] && { sacrifice: true as const }) },
        ...(sorcery && { sorcerySpeed: true as const }),
      });
      continue;
    }
    if (isSpell) {
      const effects = new Reader(spellTargets, tokens).effects(line);
      if (!effects) return no(line);
      spellEffects.push(...effects);
      continue;
    }
    return no(line);
  }

  if (isSpell) {
    if (spellEffects.length === 0) return no('no spell effect');
    def.spell = { targets: spellTargets, effects: spellEffects };
  }
  if (types.includes('Land')) { // 305.6: basic land types give their mana abilities
    const BASIC: Record<string, ManaType> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
    for (const sub of def.subtypes ?? []) { const c = BASIC[sub]; if (c && !def.manaAbilities?.some((a) => a.produce.includes(c))) (def.manaAbilities ??= []).push({ cost: 'tap', produce: [c] }); }
  }
  if (types.includes('Enchantment') && def.subtypes?.includes('Aura') && !def.enchant) return no('aura without enchant creature');
  if (keywords.length) def.keywords = keywords;
  if (triggers.length) def.triggers = triggers;
  if (activated.length) def.activated = activated;
  if (statics.length) def.statics = statics;
  return { ok: true, def, tokens };
}
