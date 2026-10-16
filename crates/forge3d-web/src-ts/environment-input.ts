import { Forge3DError } from "./index.js";
export const fail = (s: string): never => {
  throw new Forge3DError("INVALID_INPUT", s);
};
export const num = (v: number, lo: number, hi: number, s: string): number =>
  Number.isFinite(v) && v >= lo && v <= hi ? v : fail(s);
export const vec = (v: readonly number[], n: number, s: string): number[] =>
  v != null &&
  v.length === n &&
  typeof v.every === "function" &&
  v.every(Number.isFinite)
    ? Array.from(v)
    : fail(s);
export const rgb = (
  v: [number, number, number],
  s: string,
): [number, number, number] =>
  vec(v, 3, s).map((x) => num(x, 0, 65504, s)) as [number, number, number];
export const choice = <T extends string>(
  v: T,
  values: readonly string[],
  s: string,
): T => (values.includes(v) ? v : fail(s));
