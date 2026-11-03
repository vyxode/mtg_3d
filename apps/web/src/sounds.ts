import type { GameEvent, PlayerId } from '@mtg3d/engine';

/** Table sounds, synthesised with Web Audio: no sound files to download or license. */
export type Sound = 'shuffle' | 'draw' | 'place' | 'slide' | 'tap' | 'hit' | 'gain' | 'myTurn' | 'theirTurn' | 'win' | 'lose';

const KEY = 'mtg3d.sound';
export function soundOn(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function setSoundOn(on: boolean): void {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage blocked: only this page load */ }
}

/** The sounds one server update makes, in order, each kind at most once (a whole combat is one thud, not ten). */
export function soundsFor(events: readonly GameEvent[], viewer: PlayerId): Sound[] {
  const out: Sound[] = [];
  const add = (s: Sound) => { if (!out.includes(s)) out.push(s); };
  for (const e of events) {
    if (e.kind === 'shuffled') add('shuffle');
    else if (e.kind === 'drew') add('draw');
    else if (e.kind === 'zoneChange' && !(e.fromZone === 'library' && e.toZone === 'hand')) add(e.toZone === 'battlefield' ? 'place' : 'slide');
    else if (e.kind === 'tapped') add('tap');
    else if (e.kind === 'lifeChanged') add(e.to < e.from ? 'hit' : 'gain');
    else if (e.kind === 'damage') add('hit');
    else if (e.kind === 'turnStarted') add(e.active === viewer ? 'myTurn' : 'theirTurn');
    else if (e.kind === 'gameOver') add(e.result.winner === viewer ? 'win' : 'lose');
  }
  return out;
}

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
function audio(): AudioContext | null {
  if (typeof AudioContext !== 'function') return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume(); // browsers start it suspended until the first click
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return ctx;
}

/** A burst of filtered noise: paper and felt. */
function rustle(a: AudioContext, at: number, dur: number, type: BiquadFilterType, f0: number, f1: number, vol: number) {
  const src = a.createBufferSource();
  src.buffer = noise;
  const filter = a.createBiquadFilter();
  filter.type = type;
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(f0, at);
  filter.frequency.exponentialRampToValueAtTime(f1, at + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + Math.min(0.012, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter).connect(g).connect(a.destination);
  src.start(at, Math.random() * 0.5, dur + 0.05);
}

/** A sine with a pitch glide and a bell-like decay. */
function tone(a: AudioContext, at: number, f0: number, f1: number, dur: number, vol: number) {
  const o = a.createOscillator();
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(f1, at + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

function play(s: Sound, at: number, a: AudioContext) {
  switch (s) {
    case 'shuffle': for (let i = 0; i < 16; i++) rustle(a, at + i * 0.026 + Math.random() * 0.01, 0.04, 'bandpass', 3800, 2600, 0.08 + Math.random() * 0.06); break;
    case 'draw': rustle(a, at, 0.18, 'bandpass', 2600, 900, 0.22); break;
    case 'slide': rustle(a, at, 0.14, 'bandpass', 2000, 800, 0.16); break;
    case 'place': rustle(a, at, 0.06, 'lowpass', 1800, 700, 0.3); tone(a, at, 120, 55, 0.14, 0.25); break;
    case 'tap': rustle(a, at, 0.05, 'highpass', 2400, 1800, 0.1); break;
    case 'hit': tone(a, at, 95, 42, 0.32, 0.4); rustle(a, at, 0.12, 'lowpass', 900, 200, 0.18); break;
    case 'gain': tone(a, at, 520, 780, 0.35, 0.08); break;
    case 'myTurn': tone(a, at, 660, 655, 0.9, 0.09); tone(a, at + 0.09, 990, 985, 0.9, 0.06); break;
    case 'theirTurn': tone(a, at, 440, 437, 0.7, 0.06); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => { tone(a, at + i * 0.12, f, f, 0.8, 0.08); }); break;
    case 'lose': [392, 330, 262].forEach((f, i) => { tone(a, at + i * 0.18, f, f * 0.98, 0.9, 0.08); }); break;
  }
}

export function playSounds(sounds: readonly Sound[]): void {
  if (sounds.length === 0 || !soundOn()) return;
  const a = audio();
  if (!a) return;
  sounds.forEach((s, i) => { play(s, a.currentTime + 0.02 + i * 0.09, a); });
}
