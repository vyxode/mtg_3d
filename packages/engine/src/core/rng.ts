/**
 * Deterministic PRNG (xoshiro128**) whose state lives inside the game state.
 * Same seed + same calls => same game, which makes replays, reconnection and tests possible.
 * Not cryptographic: the server must generate the seed with a CSPRNG and never send it to clients.
 */
export type RngState = readonly [number, number, number, number];

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export function seedRng(seed: number): RngState {
  if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer, got ${String(seed)}`);
  // splitmix32 expands one seed into four well-mixed words; it never yields an all-zero state.
  let x = seed | 0;
  const next = (): number => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  return [next(), next(), next(), next()];
}

export function nextUint32(s: RngState): [number, RngState] {
  const [s0, s1, s2, s3] = s;
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  const n2 = (s2 ^ s0) >>> 0;
  const n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;
  return [result, [n0, n1, (n2 ^ t) >>> 0, rotl(n3, 11)]];
}

/** Uniform integer in [0, maxExclusive), without modulo bias. */
export function nextInt(s: RngState, maxExclusive: number): [number, RngState] {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new RangeError(`maxExclusive must be an integer in [1, 2^32], got ${String(maxExclusive)}`);
  }
  const limit = 2 ** 32 - (2 ** 32 % maxExclusive);
  let state = s;
  for (;;) {
    const [x, next] = nextUint32(state);
    state = next;
    if (x < limit) return [x % maxExclusive, state];
  }
}

/** Fisher–Yates shuffle. Returns a new array; the input is not modified. */
export function shuffle<T>(items: readonly T[], s: RngState): [T[], RngState] {
  const out = [...items];
  let state = s;
  for (let i = out.length - 1; i > 0; i--) {
    const [j, next] = nextInt(state, i + 1);
    state = next;
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return [out, state];
}
