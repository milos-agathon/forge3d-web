import { Forge3DError } from "./index.js";
import { finite, scatterInvalid } from "./scatter-mesh.js";
import { loadOfflineWasm } from "./runtime-internals.js";
import type { TerrainScatterSource } from "./scatter-source.js";
import { getTerrainProbeMaterialDefaults, normalizeProbeLighting, type ProbeReflectionMaterial, type ProbeReflectionLighting } from "./probe-bake-options.js";
export { getTerrainProbeMaterialDefaults } from "./probe-bake-options.js";
export type { ProbeReflectionMaterial, ProbeReflectionLighting } from "./probe-bake-options.js";

export interface TerrainProbeGrid { origin: readonly [number, number]; spacing: readonly [number, number]; dims: readonly [number, number]; heightOffset?: number; edgeBlend?: readonly [number, number] }
export interface TerrainProbeBakeOptions {
  grid: TerrainProbeGrid; skyColor?: readonly [number, number, number]; skyIntensity?: number;
  rayCount?: number; maxTraceDistance?: number; reflectionResolution?: number;
  reflectionSamples?: number; terrainColor?: readonly [number, number, number]; signal?: AbortSignal;
  reflectionMaterial?: Partial<ProbeReflectionMaterial>; reflectionLighting?: ProbeReflectionLighting;
  /** CPU bake output admission; defaults to 64 MiB. GPU commits use the runtime ledger. */
  memoryBudgetBytes?: number;
}
export interface TerrainProbeSnapshot {
  grid: Required<TerrainProbeGrid>; positions: Float32Array;
  /** Probe-major: nine native z-up SH L2 basis coefficients, packed RGB. */
  coefficients: Float32Array; reflectionResolution: number; reflectionMips: Float32Array[];
  strength: number; reflectionStrength: number; debug: "none" | "irradiance" | "reflections" | "weight";
}
export interface TerrainProbeMemoryReport { probeCount: number; coefficientBytes: number; reflectionBytes: number; positionBytes: number; gpuBytes: number }
export function probeShBasis(direction: readonly [number, number, number]): number[] {
  // Public directions use y-up; baseline coefficients are z-up.
  const [x, z, y] = direction;
  return [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
}
function normalize(v: number[]): [number, number, number] { const length = Math.hypot(...v); return v.map(x => x / Math.max(length, 1e-12)) as [number, number, number]; }
function sample(source: TerrainScatterSource, x: number, z: number): number | undefined {
  if (x < source.origin[0] || z < source.origin[1] || x > source.origin[0]+source.terrainWidth || z > source.origin[1]+source.terrainWidth) return undefined;
  const [r, c] = source.contractToPixel(x, z); return source.sampleScaledHeight(r, c);
}
export function probeCubeDirection(face: number, u: number, v: number): [number, number, number] {
  const directions = [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]];
  if (!directions[face]) scatterInvalid("cubemap face must be in [0, 5]");
  const [x, y, z] = normalize(directions[face]!);
  return [x, z, y];
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Forge3DError("REQUEST_CANCELLED", "probe bake cancelled"); }
export class TerrainLightingProbes {
  #value: TerrainProbeSnapshot | undefined;
  constructor(snapshot: TerrainProbeSnapshot) {
    validateProbeSnapshot(snapshot); this.#value = structuredClone(snapshot);
  }
  static async bake(source: TerrainScatterSource, options: TerrainProbeBakeOptions): Promise<TerrainLightingProbes> {
    checkAbort(options.signal);
    const grid = normalizeProbeGrid(options.grid), count = grid.dims[0] * grid.dims[1];
    const sky = options.skyColor ?? [0.6, 0.75, 1]; if (sky.length !== 3) scatterInvalid("skyColor requires RGB"); sky.forEach(x => finite(x, "skyColor", 0));
    const intensity = finite(options.skyIntensity ?? 1, "skyIntensity", 0), rays = options.rayCount ?? 64, maxDistance = finite(options.maxTraceDistance ?? source.terrainWidth / 2, "maxTraceDistance", Number.MIN_VALUE);
    if (!Number.isInteger(rays) || rays < 1 || rays > 4096) scatterInvalid("rayCount must be in [1, 4096]");
    const resolution = options.reflectionResolution ?? 8, samples = options.reflectionSamples ?? 32;
    if (!Number.isInteger(resolution) || resolution < 1 || resolution > 64 || (resolution & (resolution - 1))) scatterInvalid("reflectionResolution must be a power of two in [1, 64]");
    if (!Number.isInteger(samples) || samples < 1 || samples > 256) scatterInvalid("reflectionSamples must be in [1, 256]");
    const terrainColor = options.terrainColor ?? [0.3, 0.4, 0.2]; if (terrainColor.length !== 3) scatterInvalid("terrainColor requires RGB"); terrainColor.forEach(x => finite(x, "terrainColor", 0));
    const mipTexels=Array.from({length:Math.log2(resolution)+1},(_,level)=>(resolution>>level)**2).reduce((a,b)=>a+b,0)*6*count;
    const budget=finite(options.memoryBudgetBytes??64*1024*1024,"memoryBudgetBytes",1);
    if(64+count*160+mipTexels*16>budget) throw new Forge3DError("RESOURCE_LIMIT_EXCEEDED","probe bake output exceeds memoryBudgetBytes");
    const reflectionMaterial={...getTerrainProbeMaterialDefaults(terrainColor),...options.reflectionMaterial};
    const reflectionLighting=normalizeProbeLighting(options.reflectionLighting,intensity);
    const bridge = await loadOfflineWasm();
    if (!bridge.bakeTerrainProbe) throw new Forge3DError("UNSUPPORTED_FEATURE", "WASM bridge does not export the W09 probe baker");
    const scaledHeights = Float32Array.from(source.heights, h => (h - source.minHeight) * source.zScale);
    const positions = new Float32Array(count * 3), coefficients = new Float32Array(count * 27);
    const mips = Array.from({ length: Math.log2(resolution) + 1 }, (_, level) => new Float32Array(count * 6 * (resolution >> level) ** 2 * 4));
    for (let p = 0; p < count; p++) {
      checkAbort(options.signal);
      const x = grid.origin[0] + (p % grid.dims[0]) * grid.spacing[0], z = grid.origin[1] + Math.floor(p / grid.dims[0]) * grid.spacing[1], h = sample(source, x, z);
      if (h === undefined) scatterInvalid("probe grid must lie over the terrain");
      const origin: [number, number, number] = [x, h + grid.heightOffset, z]; positions.set(origin, p * 3);
      const result = bridge.bakeTerrainProbe!({ heights: scaledHeights, width: source.width, height: source.height, terrainWidth: source.terrainWidth, terrainOrigin:source.origin, position: origin, skyColor: sky, skyIntensity: intensity, rayCount: rays, maxTraceDistance: maxDistance, reflectionResolution: resolution, reflectionSamples: samples, terrainColor, reflectionMaterial, reflectionLighting });
      coefficients.set(result.coefficients, p * 27);
      result.reflectionMips.forEach((mip, level) => mips[level]!.set(mip, p * mip.length));
      // Yield at probe boundaries so cancellation and input can be processed.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkAbort(options.signal);
    return new TerrainLightingProbes({ grid, positions, coefficients, reflectionResolution: resolution, reflectionMips: mips, strength: 1, reflectionStrength: 1, debug: "none" });
  }
  get disposed(): boolean { return this.#value === undefined; }
  snapshot(): TerrainProbeSnapshot { if (!this.#value) throw new Forge3DError("RUNTIME_DISPOSED", "lighting probes disposed"); return structuredClone(this.#value); }
  setStrength(irradiance: number, reflection = irradiance): void { const value = this.snapshot(); value.strength = finite(irradiance, "strength", 0, 1); value.reflectionStrength = finite(reflection, "reflectionStrength", 0, 1); this.#value = value; }
  setDebug(debug: TerrainProbeSnapshot["debug"]): void { const value = this.snapshot(); if (!["none", "irradiance", "reflections", "weight"].includes(debug)) scatterInvalid("invalid probe debug mode"); value.debug = debug; this.#value = value; }
  memoryReport(): TerrainProbeMemoryReport { const v = this.snapshot(); return { probeCount: v.positions.length / 3, coefficientBytes: v.coefficients.byteLength, reflectionBytes: v.reflectionMips.reduce((s, mip) => s + mip.byteLength, 0), positionBytes: v.positions.byteLength, gpuBytes: packTerrainProbes(v).byteLength }; }
  dispose(): void { this.#value = undefined; }
}
export function normalizeProbeGrid(input: TerrainProbeGrid): Required<TerrainProbeGrid> {
  if (!input || input.origin?.length !== 2 || input.spacing?.length !== 2 || input.dims?.length !== 2) scatterInvalid("probe grid requires origin, spacing and dims pairs");
  input.origin.forEach(x => finite(x, "origin")); input.spacing.forEach(x => finite(x, "spacing", Number.MIN_VALUE));
  input.dims.forEach(x => { if (!Number.isInteger(x) || x < 1 || x > 64) scatterInvalid("probe dimensions must be in [1, 64]"); });
  if (input.dims[0] * input.dims[1] > 256) scatterInvalid("probe count exceeds 256");
  const edgeBlend = input.edgeBlend ?? [input.spacing[0], input.spacing[1]];
  if (edgeBlend.length !== 2) scatterInvalid("edgeBlend requires a pair");
  edgeBlend.forEach(x => finite(x, "edgeBlend", Number.MIN_VALUE));
  return { origin: [...input.origin], spacing: [...input.spacing], dims: [...input.dims], heightOffset: finite(input.heightOffset ?? 5, "heightOffset", Number.MIN_VALUE), edgeBlend: [...edgeBlend] };
}
export function validateProbeSnapshot(input: TerrainProbeSnapshot): void {
  const grid = normalizeProbeGrid(input.grid), count = grid.dims[0] * grid.dims[1];
  if (input.positions.length !== count * 3 || input.coefficients.length !== count * 27) scatterInvalid("probe placement/coefficient dimensions mismatch");
  const size = input.reflectionResolution;
  if (!Number.isInteger(size) || size < 1 || size > 64 || (size & (size - 1)) || input.reflectionMips.length !== Math.log2(size) + 1) scatterInvalid("reflection mip dimensions mismatch");
  for (let i = 0; i < input.reflectionMips.length; i++) if (input.reflectionMips[i]!.length !== count * 6 * (size >> i) ** 2 * 4) scatterInvalid("reflection mip texel count mismatch");
  for (const field of [input.positions, input.coefficients, ...input.reflectionMips]) { if (!(field instanceof Float32Array)) scatterInvalid("probe data must be Float32Array"); field.forEach(x => finite(x, "probe value")); }
  finite(input.strength, "strength", 0, 1); finite(input.reflectionStrength, "reflectionStrength", 0, 1);
  if (!["none", "irradiance", "reflections", "weight"].includes(input.debug)) scatterInvalid("invalid probe debug mode");
}
/** Storage buffer is vec4-aligned, with 4 header vectors then 10 vectors per probe. */
export function packTerrainProbes(v: TerrainProbeSnapshot): Float32Array {
  validateProbeSnapshot(v);
  const count = v.positions.length / 3, length = 16 + count * 40 + v.reflectionMips.reduce((s, mip) => s + mip.length, 0), out = new Float32Array(length);
  out.set([v.grid.origin[0], v.grid.origin[1], v.grid.spacing[0], v.grid.spacing[1], v.grid.dims[0], v.grid.dims[1], v.strength, v.reflectionStrength, v.grid.edgeBlend[0], v.grid.edgeBlend[1], v.reflectionResolution, v.reflectionMips.length, count, ["none", "irradiance", "reflections", "weight"].indexOf(v.debug), 0, 0]);
  for (let p = 0; p < count; p++) { out.set(v.positions.subarray(p * 3, p * 3 + 3), 16 + p * 40); for (let k = 0; k < 9; k++) out.set(v.coefficients.subarray(p * 27 + k * 3, p * 27 + k * 3 + 3), 20 + p * 40 + k * 4); }
  let offset = 16 + count * 40; for (const mip of v.reflectionMips) { out.set(mip, offset); offset += mip.length; }
  return out;
}
