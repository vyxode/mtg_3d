import { CARDS, displayName, spanish } from '@mtg3d/cards';

/** Card images are 488 × 680 (Scryfall "normal"); the frame drawn here has the same size so the image can replace it. */
export const IMG_W = 488;
export const IMG_H = 680;

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D no disponible');
  return [c, ctx];
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) { ctx.fillText(line, x, y); y += lineHeight; line = word; } else line = next;
  }
  ctx.fillText(line, x, y);
  return y;
}

const FRAME: Record<string, string> = { W: '#d9cfae', U: '#3a6ea8', B: '#4a3f3a', R: '#a8442f', G: '#3b7448', multi: '#b8913f', none: '#857a68' };
const TYPE_ES: Record<string, string> = { Creature: 'Criatura', Land: 'Tierra', Instant: 'Instantáneo', Sorcery: 'Conjuro', Enchantment: 'Encantamiento', Artifact: 'Artefacto', Planeswalker: 'Planeswalker', Battle: 'Batalla' };

/** Shown while the image loads, and kept if Scryfall cannot be reached: a plain card frame with the card's own data, never a wrong picture. */
export function placeholder(name: string): HTMLCanvasElement {
  const [c, ctx] = canvas(IMG_W, IMG_H);
  const def = CARDS.get(name);
  const es = spanish(name);
  const cost = def?.manaCost;
  const colors = cost ? (['W', 'U', 'B', 'R', 'G'] as const).filter((k) => (cost[k] ?? 0) > 0) : [];
  const tint = FRAME[colors.length > 1 ? 'multi' : colors[0] ?? 'none'] ?? '#857a68';
  ctx.fillStyle = '#0b0a09'; // black border
  ctx.beginPath(); ctx.roundRect(0, 0, IMG_W, IMG_H, 24); ctx.fill();
  const frame = ctx.createLinearGradient(0, 0, IMG_W, IMG_H);
  frame.addColorStop(0, tint);
  frame.addColorStop(1, '#1a1612');
  ctx.fillStyle = frame;
  ctx.beginPath(); ctx.roundRect(20, 20, IMG_W - 40, IMG_H - 40, 10); ctx.fill();
  const bar = (y: number, h: number, x = 34, w = IMG_W - 68) => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#f3ead6'); g.addColorStop(1, '#cfc2a4');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 12); ctx.fill();
  };
  // Title bar: name on the left, mana cost on the right.
  bar(34, 52);
  const pips: string[] = cost ? [...(cost.generic ? [String(cost.generic)] : []), ...(['W', 'U', 'B', 'R', 'G', 'C'] as const).flatMap((k) => Array<string>(cost[k] ?? 0).fill(k))] : [];
  const PIP: Record<string, string> = { W: '#f6f0d8', U: '#a9d1ee', B: '#b9aea8', R: '#efa184', G: '#9fd0a6' };
  pips.forEach((s, i) => {
    const x = IMG_W - 58 - (pips.length - 1 - i) * 34;
    ctx.fillStyle = PIP[s] ?? '#cbc3b6';
    ctx.beginPath(); ctx.arc(x, 60, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1612'; ctx.font = '700 20px "Alegreya Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s, x, 61);
  });
  ctx.fillStyle = '#1a1612'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '700 28px Alegreya, Georgia, serif';
  ctx.fillText(displayName(name), 50, 61, IMG_W - 110 - pips.length * 34);
  // Art box: no art is drawn (it would be a wrong picture); a soft gradient with the frame colour.
  const art = ctx.createRadialGradient(IMG_W / 2, 220, 20, IMG_W / 2, 220, 260);
  art.addColorStop(0, tint); art.addColorStop(1, '#0e0c0a');
  ctx.fillStyle = art;
  ctx.fillRect(42, 96, IMG_W - 84, 270);
  ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 4; ctx.strokeRect(42, 96, IMG_W - 84, 270);
  // Type line.
  bar(374, 44);
  const type = es?.type || [...(def?.supertypes ?? []).map((s) => (s === 'Legendary' ? 'Legendario' : 'Básica')), ...(def?.types ?? []).map((t) => TYPE_ES[t] ?? t)].join(' ');
  ctx.fillStyle = '#1a1612'; ctx.font = '600 22px Alegreya, Georgia, serif';
  ctx.fillText(type, 50, 397, IMG_W - 100);
  // Text box with the Spanish rules text.
  ctx.fillStyle = '#efe6d2';
  ctx.fillRect(42, 426, IMG_W - 84, 206);
  ctx.fillStyle = '#241e17'; ctx.textBaseline = 'alphabetic'; ctx.font = '19px Alegreya, Georgia, serif';
  ctx.save();
  ctx.beginPath(); ctx.rect(42, 426, IMG_W - 84, 176); ctx.clip(); // long texts are cut, the full text is in the preview
  let y = 454;
  for (const para of (es?.text ?? '').split('\n')) y = wrap(ctx, para, 54, y, IMG_W - 108, 22) + 28;
  ctx.restore();
  if (def?.power !== undefined) { // power/toughness box
    bar(604, 46, IMG_W - 140, 98);
    ctx.fillStyle = '#1a1612'; ctx.font = '700 28px "Alegreya Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${String(def.power)}/${String(def.toughness)}`, IMG_W - 91, 628);
  }
  return c;
}

const urls = new Map<string, string>();
/** The frame as an image URL, for the DOM (drawn once per card). */
export function placeholderUrl(name: string): string {
  let u = urls.get(name);
  if (!u) { u = placeholder(name).toDataURL('image/png'); urls.set(name, u); }
  return u;
}
