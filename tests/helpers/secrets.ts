/** Seeded PRNG (mulberry32) so the rate tests cannot flake. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SEED = 20261019;

const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type SecretKind = 'hex' | 'base64' | 'base64url' | 'aws';

function draw(rng: () => number, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/** A random secret. Lengths are uniform 32 to 64 except the AWS shape (40). */
export function randomSecret(rng: () => number, kind: SecretKind, length?: number): string {
  const n = length ?? 32 + Math.floor(rng() * 33);
  if (kind === 'hex') return draw(rng, HEX, n);
  if (kind === 'base64') return draw(rng, BASE64, n);
  if (kind === 'base64url') return draw(rng, BASE64URL, n);
  return draw(rng, BASE64, 40);
}

export function randomToken(rng: () => number, kind: 'hex' | 'base64url', length: number): string {
  return draw(rng, kind === 'hex' ? HEX : BASE64URL, length);
}

export function randomUuid(rng: () => number): string {
  const h = (n: number) => draw(rng, HEX, n);
  return `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`;
}

/** Longest stretch of `secret` that survives unmasked in `output`. */
export function longestSurvivingFragment(secret: string, output: string): number {
  let best = 0;
  for (let start = 0; start < secret.length; start++) {
    let length = Math.max(best + 1, 1);
    while (start + length <= secret.length && output.includes(secret.slice(start, start + length))) {
      best = length;
      length += 1;
    }
  }
  return best;
}
