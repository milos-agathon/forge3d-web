import { scatterInvalid } from "./scatter-mesh.js";

// NumPy SeedSequence + PCG64 XSL-RR contract (not PCG64DXSM).
// Algorithm references: numpy/random/bit_generator.pyx and src/pcg64/pcg64.h.
// Independent implementation using JS uint32 multiplication and 128-bit BigInt.
export function scatterRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0) scatterInvalid("seed must be a nonnegative safe integer");
  const words = [seed >>> 0];
  if (seed >= 4294967296) words.push(Math.floor(seed / 4294967296));
  let hash = 0x43b0d7e5;
  const hashWord = (word: number): number => {
    const value = word ^ hash;
    hash = Math.imul(hash, 0x931e8875) >>> 0;
    const product = Math.imul(value, hash) >>> 0;
    return (product ^ product >>> 16) >>> 0;
  };
  const mix = (a: number, b: number): number => {
    const value = (Math.imul(a, 0xca01f9dd) - Math.imul(b, 0x4973f715)) >>> 0;
    return (value ^ value >>> 16) >>> 0;
  };
  const pool = Array.from({ length: 4 }, (_, i) => hashWord(words[i] ?? 0));
  for (let source = 0; source < 4; source++) for (let target = 0; target < 4; target++) {
    if (source !== target) pool[target] = mix(pool[target]!, hashWord(pool[source]!));
  }
  hash = 0x8b51f9dd;
  const stateWords = Array.from({ length: 8 }, (_, i) => {
    const value = pool[i % 4]! ^ hash;
    hash = Math.imul(hash, 0x58f38ded) >>> 0;
    const product = Math.imul(value, hash) >>> 0;
    return BigInt((product ^ product >>> 16) >>> 0);
  });
  const word64 = (i: number): bigint => stateWords[i]! | stateWords[i + 1]! << 32n;
  const initial = word64(0) << 64n | word64(2);
  const mask128 = (1n << 128n) - 1n, mask64 = (1n << 64n) - 1n;
  const increment = ((word64(4) << 64n | word64(6)) << 1n | 1n) & mask128;
  const multiplier = 47026247687942121848144207491837523525n;
  let state = ((increment + initial) * multiplier + increment) & mask128;
  return () => {
    state = (state * multiplier + increment) & mask128;
    const value = ((state >> 64n) ^ (state & mask64)), rotation = state >> 122n;
    const rotated = ((value >> rotation) | (value << ((64n - rotation) & 63n))) & mask64;
    return Number(rotated >> 11n) / 9007199254740992;
  };
}
