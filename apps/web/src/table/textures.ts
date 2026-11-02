import { CanvasTexture, ImageLoader, SRGBColorSpace, Texture } from 'three';
import { cardImage } from '../net';

/** Scryfall "normal" images are 488 × 680; placeholders use the same size so the image can replace them in place. */
const IMG_W = 488;
const IMG_H = 680;
const CAPACITY = 160;

const loader = new ImageLoader();
loader.setCrossOrigin('anonymous');

const listeners = new Set<() => void>();
/** Called when any card image finishes loading, so a scene rendering on demand can redraw. */
export function onTextureLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
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
}

/** Shown while the image loads, and kept if Scryfall cannot be reached: the card's name, never a wrong picture. */
function placeholder(name: string): HTMLCanvasElement {
  const [c, ctx] = canvas(IMG_W, IMG_H);
  const g = ctx.createLinearGradient(0, 0, IMG_W, IMG_H);
  g.addColorStop(0, '#1b1916');
  g.addColorStop(1, '#0d0c0b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, IMG_W, IMG_H);
  ctx.strokeStyle = '#4a4234';
  ctx.lineWidth = 6;
  ctx.strokeRect(22, 22, IMG_W - 44, IMG_H - 44);
  ctx.fillStyle = '#efe6d2';
  ctx.font = '700 46px Alegreya, Georgia, serif';
  ctx.textAlign = 'center';
  wrap(ctx, name, IMG_W / 2, 120, IMG_W - 80, 54);
  return c;
}

const cache = new Map<string, Texture<HTMLCanvasElement | HTMLImageElement>>();

/** Card face texture, least-recently-used cache; evicted textures are disposed (three re-uploads them if used again). */
export function cardTexture(name: string): Texture {
  const hit = cache.get(name);
  if (hit) {
    cache.delete(name);
    cache.set(name, hit);
    return hit;
  }
  const tex = new Texture<HTMLCanvasElement | HTMLImageElement>(placeholder(name));
  tex.needsUpdate = true;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(name, tex);
  loader.load(cardImage(name), (img) => {
    tex.image = img;
    tex.needsUpdate = true;
    for (const fn of listeners) fn();
  }, undefined, () => { /* keep the named placeholder */ });
  if (cache.size > CAPACITY) {
    const [oldest] = cache.keys();
    if (oldest !== undefined) { cache.get(oldest)?.dispose(); cache.delete(oldest); }
  }
  return tex;
}

let back: Texture | null = null;
/** Our own card back: the official Magic back is Wizards of the Coast's artwork and is not used. */
export function backTexture(): Texture {
  if (back) return back;
  const [c, ctx] = canvas(IMG_W, IMG_H);
  const g = ctx.createLinearGradient(0, 0, IMG_W, IMG_H);
  g.addColorStop(0, '#1d2a44');
  g.addColorStop(1, '#0d1220');
  ctx.fillStyle = '#0b0c0f';
  ctx.fillRect(0, 0, IMG_W, IMG_H);
  ctx.fillStyle = g;
  ctx.fillRect(16, 16, IMG_W - 32, IMG_H - 32);
  ctx.strokeStyle = '#c9a24a';
  ctx.lineWidth = 6;
  ctx.strokeRect(34, 34, IMG_W - 68, IMG_H - 68);
  ctx.globalAlpha = 0.35;
  for (let r = 40; r < 300; r += 26) {
    ctx.beginPath();
    ctx.moveTo(IMG_W / 2, IMG_H / 2 - r);
    ctx.lineTo(IMG_W / 2 + r * 0.7, IMG_H / 2);
    ctx.lineTo(IMG_W / 2, IMG_H / 2 + r);
    ctx.lineTo(IMG_W / 2 - r * 0.7, IMG_H / 2);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#c9a24a';
  ctx.font = '700 48px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('mtg_3d', IMG_W / 2, IMG_H / 2 + 16);
  back = new CanvasTexture(c);
  back.colorSpace = SRGBColorSpace;
  return back;
}

// shortcut: badge textures are never evicted; they are tiny and their texts repeat ("2/2", "mareada"), revisit if memory grows.
const badges = new Map<string, Texture>();
export const BADGE_ASPECT = 3;
export function badgeTexture(text: string): Texture {
  const hit = badges.get(text);
  if (hit) return hit;
  const [c, ctx] = canvas(192, 64);
  ctx.fillStyle = 'rgba(16,36,31,0.92)';
  ctx.beginPath();
  ctx.roundRect(0, 0, 192, 64, 14);
  ctx.fill();
  ctx.fillStyle = '#efe6d2';
  ctx.font = '700 36px "Alegreya Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 96, 34, 180);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  badges.set(text, tex);
  return tex;
}
