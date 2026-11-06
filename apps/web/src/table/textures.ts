import { CanvasTexture, ImageLoader, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { cardImage } from '../net';
import { IMG_H, IMG_W, canvas, placeholder } from '../placeholder';

const CAPACITY = 160;

const loader = new ImageLoader();
loader.setCrossOrigin('anonymous');

const listeners = new Set<() => void>();
/** Called when any card image finishes loading, so a scene rendering on demand can redraw. */
export function onTextureLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
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

/** Seeded noise, so the wood and the felt look the same on every load. */
function noise(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
}

let corners: Texture | null = null;
/** Alpha map with rounded corners (cards are 63 × 88 mm with ~3 mm corners). */
export function roundedCorners(): Texture {
  if (corners) return corners;
  const [c, ctx] = canvas(126, 176);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 126, 176);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(0, 0, 126, 176, 7);
  ctx.fill();
  corners = new CanvasTexture(c);
  return corners;
}

let wood: Texture | null = null;
/** A warm wooden table top, drawn once. */
export function woodTexture(): Texture {
  if (wood) return wood;
  const [c, ctx] = canvas(1024, 1024);
  const rnd = noise(7);
  ctx.fillStyle = '#3b2616';
  ctx.fillRect(0, 0, 1024, 1024);
  for (let plank = 0; plank < 6; plank++) { // planks run along x
    const y0 = plank * (1024 / 6);
    ctx.fillStyle = `hsl(${String(22 + rnd() * 5)}, ${String(30 + rnd() * 8)}%, ${String(15 + rnd() * 5)}%)`;
    ctx.fillRect(0, y0, 1024, 1024 / 6);
    for (let g = 0; g < 70; g++) { // grain
      const y = y0 + rnd() * (1024 / 6);
      ctx.strokeStyle = `rgba(30, 16, 8, ${String(0.08 + rnd() * 0.18)})`;
      ctx.lineWidth = 0.6 + rnd() * 2.2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= 1024; x += 64) ctx.lineTo(x, y + Math.sin(x / (90 + rnd() * 60) + g) * (2 + rnd() * 5));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(15, 8, 4, .55)'; // seam
    ctx.fillRect(0, y0, 1024, 2);
  }
  wood = new CanvasTexture(c);
  wood.colorSpace = SRGBColorSpace;
  wood.wrapS = wood.wrapT = RepeatWrapping;
  wood.anisotropy = 8;
  return wood;
}

/** Playmat size in world units (it holds library, graveyard and exile at its sides). */
export const MAT_W = 30;
export const MAT_D = 8.4;

const mats = new Map<string, Texture>();
/** A felt playmat with its zones printed, like a real one. `name` is printed along the edge nearest its player. */
export function matTexture(name: string, tint: string): Texture {
  const hit = mats.get(name + tint);
  if (hit) return hit;
  const W = 2048, H = Math.round(2048 * MAT_D / MAT_W);
  const [c, ctx] = canvas(W, H);
  const rnd = noise(name.length * 31 + 5);
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 26000; i++) { // felt fibres
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.6);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(212, 162, 76, 0.55)'; // stitched edge
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, W - 28, H - 28);
  ctx.setLineDash([]);
  // Zone outlines at the same places the layout puts the cards (world x → texture u, world z → v; v grows towards the player).
  const u = (x: number) => ((x + MAT_W / 2) / MAT_W) * W;
  const v = (z: number) => ((z - (4.8 - MAT_D / 2)) / MAT_D) * H;
  const zone = (x: number, z: number, label: string) => {
    const w = (2.3 / MAT_W) * W, h = (3.1 / MAT_D) * H;
    ctx.strokeStyle = 'rgba(239, 230, 210, 0.22)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(u(x) - w / 2, v(z) - h / 2, w, h, 12);
    ctx.stroke();
    ctx.fillStyle = 'rgba(239, 230, 210, 0.32)';
    ctx.font = 'italic 30px Alegreya, Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, u(x), v(z) + h / 2 + 34);
  };
  zone(13, 6.6, 'Biblioteca');
  zone(13, 3, 'Cementerio');
  zone(-13, 3, 'Exilio');
  ctx.fillStyle = 'rgba(239, 230, 210, 0.28)';
  ctx.font = '700 44px Alegreya, Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, W / 2, H - 36);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  mats.set(name + tint, tex);
  return tex;
}

let rune: Texture | null = null;
/** A glowing circle drawn under spells on the stack: rings, ticks and a star, all our own geometry. */
export function runeTexture(): Texture {
  if (rune) return rune;
  const S = 512, c0 = S / 2;
  const [c, ctx] = canvas(S, S);
  ctx.strokeStyle = '#ffd890';
  ctx.shadowColor = '#ffb347';
  ctx.shadowBlur = 14;
  const circle = (r: number, w: number) => { ctx.lineWidth = w; ctx.beginPath(); ctx.arc(c0, c0, r, 0, Math.PI * 2); ctx.stroke(); };
  circle(240, 5); circle(222, 2); circle(150, 3); circle(60, 2);
  for (let i = 0; i < 48; i++) { // ticks between the outer rings
    const a = (i / 48) * Math.PI * 2, r0 = i % 4 === 0 ? 196 : 210;
    ctx.lineWidth = i % 4 === 0 ? 4 : 2;
    ctx.beginPath(); ctx.moveTo(c0 + Math.cos(a) * r0, c0 + Math.sin(a) * r0); ctx.lineTo(c0 + Math.cos(a) * 222, c0 + Math.sin(a) * 222); ctx.stroke();
  }
  for (const turn of [0, Math.PI]) { // a six-pointed star: two triangles
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let k = 0; k <= 3; k++) { const a = turn - Math.PI / 2 + (k * 2 * Math.PI) / 3; ctx.lineTo(c0 + Math.cos(a) * 150, c0 + Math.sin(a) * 150); }
    ctx.stroke();
  }
  rune = new CanvasTexture(c);
  rune.colorSpace = SRGBColorSpace;
  return rune;
}

let dot: Texture | null = null;
/** A soft round spot of light, for particles. */
export function dotTexture(): Texture {
  if (dot) return dot;
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  dot = new CanvasTexture(c);
  return dot;
}

const lives = new Map<number, Texture>();
/** The face of a life counter: a big number on a dark disc with a brass ring. */
export function lifeTexture(n: number): Texture {
  const hit = lives.get(n);
  if (hit) return hit;
  const [c, ctx] = canvas(256, 256);
  const g = ctx.createRadialGradient(128, 110, 10, 128, 128, 128);
  g.addColorStop(0, '#2a3a35');
  g.addColorStop(1, '#0c1210');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(128, 128, 128, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#d4a24c'; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(128, 128, 112, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = n <= 5 ? '#ff8a6a' : '#f3ead6';
  ctx.font = `700 ${String(Math.abs(n) >= 100 ? 92 : 128)}px Alegreya, Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 128, 138);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  lives.set(n, tex);
  return tex;
}
