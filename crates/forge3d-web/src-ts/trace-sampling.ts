import type { TraceVec3, TraceLight } from "./trace-types.js";
import {
  integer,
  scalar,
  clamp,
  unit,
  add,
  mul,
  cross,
  f,
  traceInvalid,
  live,
  traceLimit,
} from "./trace-math.js";
export interface RestirConfig {
  initialCandidates: number;
  temporalNeighbors: number;
  spatialNeighbors: number;
  spatialRadius: number;
  depthThreshold: number;
  normalThreshold: number;
  maxTemporalAge: number;
  biasCorrection: boolean;
}
export function normalizeRestirConfig(
  input: Partial<RestirConfig> = {},
): RestirConfig {
  return {
    initialCandidates: integer(
      input.initialCandidates ?? 32,
      "initialCandidates",
      1,
      256,
    ),
    temporalNeighbors: integer(
      input.temporalNeighbors ?? 1,
      "temporalNeighbors",
      0,
      8,
    ),
    spatialNeighbors: integer(
      input.spatialNeighbors ?? 4,
      "spatialNeighbors",
      0,
      32,
    ),
    spatialRadius: scalar(input.spatialRadius ?? 16, "spatialRadius", 1e-6),
    depthThreshold: scalar(input.depthThreshold ?? 0.1, "depthThreshold", 0, 1),
    normalThreshold: scalar(
      input.normalThreshold ?? 0.9,
      "normalThreshold",
      0,
      1,
    ),
    maxTemporalAge: integer(
      input.maxTemporalAge ?? 20,
      "maxTemporalAge",
      1,
      256,
    ),
    biasCorrection: input.biasCorrection ?? true,
  };
}
/** Vose alias sampling, preserving the native weighted-light contract. */
export class AliasTable {
  readonly probability: Float32Array;
  readonly alias: Uint32Array;
  readonly pdf: Float32Array;
  constructor(weights: readonly number[]) {
    weights.forEach((w) => scalar(w, "weight", 0));
    const n = weights.length,
      sum = weights.reduce((a, b) => a + b, 0);
    if (n && sum <= 0) traceInvalid("light weights must have positive sum");
    this.probability = new Float32Array(n);
    this.alias = new Uint32Array(n);
    this.pdf = new Float32Array(n);
    const scaled = weights.map((w, i) => {
        this.pdf[i] = w / sum;
        return (w * n) / sum;
      }),
      small: number[] = [],
      large: number[] = [];
    scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
    while (small.length && large.length) {
      const a = small.pop()!,
        b = large.pop()!;
      this.probability[a] = scaled[a]!;
      this.alias[a] = b;
      scaled[b] = scaled[b]! + scaled[a]! - 1;
      (scaled[b]! < 1 ? small : large).push(b);
    }
    for (const i of [...small, ...large]) {
      this.probability[i] = 1;
      this.alias[i] = i;
    }
  }
  sample(u: number, v: number): { index: number; pdf: number } | undefined {
    scalar(u, "u", 0, 1);
    scalar(v, "v", 0, 1);
    if (!this.pdf.length) return;
    const col = Math.min(this.pdf.length - 1, Math.floor(u * this.pdf.length)),
      i = v < this.probability[col]! ? col : this.alias[col]!;
    return { index: i, pdf: this.pdf[i]! };
  }
}
export interface TraceReservoir {
  sample: number;
  weightSum: number;
  selectedTarget: number;
  count: number;
  age: number;
  position?: TraceVec3;
  normal?: TraceVec3;
  depth?: number;
  u?: number;
  v?: number;
}
export const emptyReservoir = (): TraceReservoir => ({
  sample: 0,
  weightSum: 0,
  selectedTarget: 0,
  count: 0,
  age: 0,
});
export function updateReservoir(
  r: TraceReservoir,
  sample: number,
  target: number,
  proposalPdf: number,
  u: number,
  count = 1,
): void {
  scalar(target, "target", 0);
  scalar(proposalPdf, "proposalPdf", 1e-30);
  scalar(u, "u", 0, 1);
  integer(count, "count", 1);
  const weight = target / proposalPdf;
  r.count += count;
  r.weightSum += weight;
  if (weight > 0 && u * r.weightSum < weight) {
    r.sample = sample;
    r.selectedTarget = target;
  }
}
export function mergeReservoir(
  r: TraceReservoir,
  source: TraceReservoir,
  target: number,
  u: number,
  biasCorrection = true,
): void {
  if (!source.count || source.selectedTarget <= 0) return;
  const weight = biasCorrection
    ? (target * source.weightSum) / source.selectedTarget
    : source.weightSum;
  r.count += source.count;
  r.weightSum += weight;
  if (weight > 0 && u * r.weightSum < weight) {
    r.sample = source.sample;
    r.selectedTarget = target;
    r.age = source.age + 1;
    r.u = source.u ?? 0;
    r.v = source.v ?? 0;
  }
}
export const reservoirWeight = (r: TraceReservoir): number =>
  r.count && r.selectedTarget > 0
    ? r.weightSum / (r.count * r.selectedTarget)
    : 0;
export class RestirDI {
  readonly config: RestirConfig;
  #lights: TraceLight[] = [];
  #weights: number[] = [];
  #alias = new AliasTable([]);
  constructor(config: Partial<RestirConfig> = {}) {
    this.config = normalizeRestirConfig(config);
  }
  get numLights(): number {
    return this.#lights.length;
  }
  get lights(): readonly TraceLight[] {
    return structuredClone(this.#lights);
  }
  addLight(light: TraceLight, weight = light.weight ?? 1): number {
    const weights = [...this.#weights, scalar(weight, "weight", 0)],
      alias = new AliasTable(weights);
    this.#weights = weights;
    this.#lights.push(structuredClone(light));
    this.#alias = alias;
    return this.#lights.length - 1;
  }
  setLights(
    lights: readonly TraceLight[],
    weights: readonly number[] = lights.map((l) => l.weight ?? 1),
  ): void {
    if (lights.length !== weights.length)
      traceInvalid("weights must match lights");
    const alias = new AliasTable(weights);
    this.#lights = structuredClone([...lights]);
    this.#weights = [...weights];
    this.#alias = alias;
  }
  clearLights(): void {
    this.#lights = [];
    this.#weights = [];
    this.#alias = new AliasTable([]);
  }
  sampleLight(
    u: number,
    v: number,
  ): { index: number; pdf: number } | undefined {
    return this.#alias.sample(u, v);
  }
  getStatistics(): { numLights: number; config: RestirConfig } {
    return { numLights: this.numLights, config: { ...this.config } };
  }
  calculateVarianceReduction(
    reference: Float32Array,
    test: Float32Array,
  ): number {
    if (reference.length !== test.length || !reference.length)
      traceInvalid("Images must have the same nonzero shape");
    const variance = (values: Float32Array): number => {
      let mean = 0;
      for (const x of values) {
        scalar(x, "image value");
        mean += x;
      }
      mean /= values.length;
      let sum = 0;
      for (const x of values) sum += (x - mean) ** 2;
      return sum / values.length;
    };
    const a = variance(reference),
      b = variance(test);
    return a > 0 ? ((a - b) / a) * 100 : 0;
  }
}
/** Native OnlineGuidingGrid: one unit prior per directional bin. */
export class OnlineGuidingGrid {
  #weights: Float32Array;
  #disposed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly binsPerCell = 8,
    memoryBudgetBytes = 64 * 1024 * 1024,
  ) {
    integer(width, "width");
    integer(height, "height");
    integer(binsPerCell, "binsPerCell", 1, 64);
    integer(memoryBudgetBytes, "memoryBudgetBytes");
    const bytes = width * height * binsPerCell * 4;
    if (bytes > memoryBudgetBytes)
      traceLimit("guiding bytes", bytes, memoryBudgetBytes);
    this.#weights = new Float32Array(width * height * binsPerCell).fill(1);
  }
  dims(): readonly [number, number, number] {
    return [this.width, this.height, this.binsPerCell];
  }
  #offset(x: number, y: number): number {
    live(this.#disposed);
    integer(x, "x", 0, this.width - 1);
    integer(y, "y", 0, this.height - 1);
    return (y * this.width + x) * this.binsPerCell;
  }
  update(x: number, y: number, bin: number, weight = 1): void {
    const offset = this.#offset(x, y);
    integer(bin, "bin", 0, this.binsPerCell - 1);
    scalar(weight, "weight", 0);
    const value = f(this.#weights[offset + bin]! + weight);
    if (!Number.isFinite(value)) traceInvalid("guiding weight overflow");
    this.#weights[offset + bin] = value;
  }
  pdf(x: number, y: number): Float32Array {
    const offset = this.#offset(x, y),
      data = this.#weights.slice(offset, offset + this.binsPerCell),
      sum = data.reduce((a, b) => a + b, 0);
    return data.map((v) => v / sum);
  }
  snapshot(): Float32Array {
    live(this.#disposed);
    return this.#weights.slice();
  }
  restore(weights: Float32Array): void {
    live(this.#disposed);
    if (weights.length !== this.#weights.length)
      traceInvalid("guiding snapshot dimensions differ");
    for (const value of weights) scalar(value, "guiding weight", 1e-30);
    this.#weights.set(weights);
  }
  reset(): void {
    live(this.#disposed);
    this.#weights.fill(1);
  }
  dispose(): void {
    this.#disposed = true;
    this.#weights = new Float32Array(0);
  }
}
export function hgPhase(cosTheta: number, g: number): number {
  scalar(g, "g", -0.999, 0.999);
  scalar(cosTheta, "cosTheta", -1, 1);
  const d = f(f(1 + f(g * g)) - f(2 * f(g * cosTheta)));
  return f(f(1 - f(g * g)) / f(4 * Math.PI * f(d * Math.sqrt(d))));
}
export function sampleHg(
  u1: number,
  u2: number,
  g: number,
): { direction: TraceVec3; pdf: number } {
  scalar(u1, "u1", 0, 1);
  scalar(u2, "u2", 0, 1);
  scalar(g, "g", -0.999, 0.999);
  let z: number;
  if (Math.abs(g) < 1e-3) z = 1 - 2 * u1;
  else {
    const s = (1 - g * g) / (1 - g + 2 * g * u1);
    z = (1 + g * g - s * s) / (2 * g);
  }
  z = clamp(z, -1, 1);
  const r = Math.sqrt(Math.max(0, 1 - z * z)),
    phi = 2 * Math.PI * u2;
  const direction: TraceVec3 = [
    f(r * Math.cos(phi)),
    f(r * Math.sin(phi)),
    f(z),
  ];
  return { direction, pdf: hgPhase(direction[2], g) };
}
export function localToWorld(local: TraceVec3, normal: TraceVec3): TraceVec3 {
  const tangent = unit(
      cross(Math.abs(normal[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0], normal),
    ),
    bitangent = cross(normal, tangent);
  return unit(
    add(
      add(mul(tangent, local[0]), mul(bitangent, local[1])),
      mul(normal, local[2]),
    ),
  );
}
export function cosineDirection(
  u1: number,
  u2: number,
  normal: TraceVec3,
): TraceVec3 {
  const r = Math.sqrt(u1),
    phi = 2 * Math.PI * u2;
  return localToWorld(
    [f(r * Math.cos(phi)), f(r * Math.sin(phi)), f(Math.sqrt(1 - u1))],
    normal,
  );
}
