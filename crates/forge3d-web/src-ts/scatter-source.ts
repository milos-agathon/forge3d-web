import { finite, scatterInvalid } from "./scatter-mesh.js";
import type { ScatterFilters, ScatterGeneratorOptions } from "./scatter-types.js";
import { scatterRandom } from "./scatter-random.js";

export function makeScatterTransform(translation: readonly [number, number, number], yawDegrees = 0, scale = 1): Float32Array {
  translation.forEach(x => finite(x, "translation")); finite(yawDegrees, "yaw"); finite(scale, "scale", Number.MIN_VALUE);
  const angle = yawDegrees * Math.PI / 180, c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return new Float32Array([c, 0, s, translation[0], 0, scale, 0, translation[1], -s, 0, c, translation[2], 0, 0, 0, 1]);
}
export function bilinearScatterSample(field: Float32Array, width: number, height: number, row: number, col: number): number {
  const r = Math.max(0, Math.min(height - 1, row)), c = Math.max(0, Math.min(width - 1, col));
  const r0 = Math.floor(r), c0 = Math.floor(c), r1 = Math.min(r0 + 1, height - 1), c1 = Math.min(c0 + 1, width - 1);
  const tr = r - r0, tc = c - c0;
  return (1 - tr) * ((1 - tc) * field[r0 * width + c0]! + tc * field[r0 * width + c1]!) + tr * ((1 - tc) * field[r1 * width + c0]! + tc * field[r1 * width + c1]!);
}
/** Native terrain contract coordinates: x/z span [0, terrainWidth], y=(h-min)*zScale. */
export class TerrainScatterSource {
  readonly heights: Float32Array; readonly slopes: Float32Array;
  readonly width: number; readonly height: number; readonly terrainWidth: number; readonly zScale: number;
  readonly minHeight: number; readonly maxHeight: number;
  readonly origin: readonly [number,number];
  constructor(heights: Float32Array, width: number, height: number, options: { terrainWidth?: number; zScale?: number; domainMin?: number; origin?: readonly [number,number] } = {}) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || heights.length !== width * height) scatterInvalid("height dimensions must match a nonempty field");
    this.width = width; this.height = height;
    this.terrainWidth = finite(options.terrainWidth ?? Math.max(width, height), "terrainWidth", Number.MIN_VALUE);
    this.zScale = finite(options.zScale ?? 1, "zScale", Number.MIN_VALUE);
    this.origin=[...(options.origin??[0,0])];if(this.origin.length!==2)scatterInvalid("origin requires x,z");this.origin.forEach(x=>finite(x,"origin"));
    let min = Infinity, max = -Infinity;
    for (const h of heights) if (Number.isFinite(h)) { min = Math.min(min, h); max = Math.max(max, h); }
    if (min === Infinity) scatterInvalid("heightmap requires finite samples");
    this.minHeight = options.domainMin === undefined ? min : finite(options.domainMin, "domainMin"); this.maxHeight = max;
    this.heights = Float32Array.from(heights, x => Number.isFinite(x) ? x : min);
    this.slopes = new Float32Array(heights.length);
    const dx = this.terrainWidth / Math.max(width - 1, 1), dz = this.terrainWidth / Math.max(height - 1, 1);
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
      const l = Math.max(0, c - 1), rr = Math.min(width - 1, c + 1), u = Math.max(0, r - 1), d = Math.min(height - 1, r + 1);
      const gx = (this.heights[r * width + rr]! - this.heights[r * width + l]!) * this.zScale / (Math.max(1, rr - l) * dx);
      const gz = (this.heights[d * width + c]! - this.heights[u * width + c]!) * this.zScale / (Math.max(1, d - u) * dz);
      this.slopes[r * width + c] = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
    }
  }
  contractToPixel(x: number, z: number): [number, number] { return [(z-this.origin[1]) / this.terrainWidth * Math.max(this.height - 1, 1), (x-this.origin[0]) / this.terrainWidth * Math.max(this.width - 1, 1)]; }
  sampleHeight(row: number, col: number): number { return bilinearScatterSample(this.heights, this.width, this.height, row, col); }
  sampleScaledHeight(row: number, col: number): number { return (this.sampleHeight(row, col) - this.minHeight) * this.zScale; }
  sampleSlopeDegrees(row: number, col: number): number { return bilinearScatterSample(this.slopes, this.width, this.height, row, col); }
  pixelToContract(row: number, col: number): [number, number, number] { return [this.origin[0]+col / Math.max(this.width - 1, 1) * this.terrainWidth, this.sampleScaledHeight(row, col), this.origin[1]+row / Math.max(this.height - 1, 1) * this.terrainWidth]; }
}
function validateFilters(filters: ScatterFilters): void {
  for (const [name, x] of Object.entries(filters)) finite(x, name);
  if ((filters.minSlopeDegrees ?? -Infinity) > (filters.maxSlopeDegrees ?? Infinity) || (filters.minElevation ?? -Infinity) > (filters.maxElevation ?? Infinity)) scatterInvalid("filter minimum exceeds maximum");
}
function accepts(source: TerrainScatterSource, r: number, c: number, filters: ScatterFilters): boolean {
  const height = source.sampleHeight(r, c), slope = source.sampleSlopeDegrees(r, c);
  return height >= (filters.minElevation ?? -Infinity) && height <= (filters.maxElevation ?? Infinity) && slope >= (filters.minSlopeDegrees ?? -Infinity) && slope <= (filters.maxSlopeDegrees ?? Infinity);
}
function ranges(options: Pick<ScatterGeneratorOptions, "scale" | "yawDegrees">): { scale: readonly [number, number]; yaw: readonly [number, number] } {
  const scale = options.scale ?? [1, 1], yaw = options.yawDegrees ?? [0, 360];
  if (scale.length !== 2 || yaw.length !== 2) scatterInvalid("scale and yaw ranges require pairs");
  scale.forEach(x => finite(x, "scale range", Number.MIN_VALUE)); yaw.forEach(x => finite(x, "yaw range"));
  if (scale[0] > scale[1] || yaw[0] > yaw[1]) scatterInvalid("ranges must be ordered");
  return { scale, yaw };
}
interface ScatterDensityMask { data: Float32Array; width: number; height: number }
function densityMask(mask: unknown, source: TerrainScatterSource): ScatterDensityMask | undefined {
  if (mask === undefined) return undefined;
  let data: unknown, width: unknown, height: unknown;
  if (mask instanceof Float32Array) {
    data = mask; width = source.width; height = source.height;
    if (mask.length !== source.width * source.height) scatterInvalid("legacy mask dimensions must match terrain");
  } else if (mask !== null && typeof mask === "object") {
    ({ data, width, height } = mask as { data?: unknown; width?: unknown; height?: unknown });
  }
  if (!(data instanceof Float32Array) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || (width as number) < 1 || (height as number) < 1 || data.length !== (width as number) * (height as number)) {
    scatterInvalid("mask requires positive width/height and matching Float32Array data");
  }
  for (const value of data) finite(value, "mask");
  return { data, width: width as number, height: height as number };
}
function sampleDensityMask(mask: ScatterDensityMask, source: TerrainScatterSource, row: number, col: number): number {
  const maskRow = row / Math.max(source.height - 1, 1) * Math.max(mask.height - 1, 1);
  const maskCol = col / Math.max(source.width - 1, 1) * Math.max(mask.width - 1, 1);
  return Math.max(0, Math.min(1, bilinearScatterSample(mask.data, mask.width, mask.height, maskRow, maskCol)));
}
function placementPolicy(source:TerrainScatterSource,options:Pick<ScatterGeneratorOptions,"minDistance"|"edgeMargin"|"densityScale">) {
  const minimum=finite(options.minDistance??0,"minDistance",0),margin=finite(options.edgeMargin??0,"edgeMargin",0,Math.max(0,source.terrainWidth/2-1e-6)),density=finite(options.densityScale??1,"densityScale",0);
  const cells=new Map<string,[number,number,number][]>();
  return {density,inside(p:readonly [number,number,number]):boolean {
    return p[0]>=source.origin[0]+margin&&p[0]<=source.origin[0]+source.terrainWidth-margin&&p[2]>=source.origin[1]+margin&&p[2]<=source.origin[1]+source.terrainWidth-margin;
  },acceptDistance(p:[number,number,number]):boolean {
    if(!minimum)return true;
    const x=Math.floor(p[0]/minimum),z=Math.floor(p[2]/minimum);
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(const q of cells.get(`${x+dx}:${z+dz}`)??[])if(Math.hypot(q[0]-p[0],q[2]-p[2])<minimum)return false;
    const key=`${x}:${z}`,cell=cells.get(key);if(cell)cell.push(p);else cells.set(key,[p]);return true;
  }};
}
export function seededScatterTransforms(source: TerrainScatterSource, options: ScatterGeneratorOptions): Float32Array {
  const count = options.count;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) scatterInvalid("count must be in [1, 1000000]");
  const limit = options.maxAttempts ?? Math.max(count * 10, count + 1), filters = options.filters ?? {};
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000_000) scatterInvalid("maxAttempts must be in [1, 10000000]");
  validateFilters(filters); const { scale, yaw } = ranges(options), random = scatterRandom(options.seed ?? 0);
  const policy=placementPolicy(source,options), mask = densityMask(options.mask, source);
  const accepted: Float32Array[] = [];
  for (let attempt = 0; attempt < limit && accepted.length < count; attempt++) {
    const r = random() * Math.max(source.height - 1, 1), c = random() * Math.max(source.width - 1, 1);
    if (!accepts(source, r, c, filters)) continue;
    const p = source.pixelToContract(r, c);
    if (!policy.inside(p)) continue;
    if ((mask || policy.density !== 1) && random() > Math.max(0, Math.min(1, (mask ? sampleDensityMask(mask, source, r, c) : 1)*policy.density))) continue;
    if (!policy.acceptDistance(p)) continue;
    const angle = yaw[0] + random() * (yaw[1] - yaw[0]), size = scale[0] + random() * (scale[1] - scale[0]);
    accepted.push(makeScatterTransform(p, angle, size));
  }
  if (accepted.length !== count) scatterInvalid(`accepted only ${accepted.length} of ${count} requested transforms after ${limit} attempts`);
  return Float32Array.from(accepted.flatMap(t => Array.from(t)));
}
export function gridScatterTransforms(source: TerrainScatterSource, options: Omit<ScatterGeneratorOptions, "count"> & { spacing: number; jitter?: number }): Float32Array {
  const spacing = finite(options.spacing, "spacing", Number.MIN_VALUE), jitter = finite(options.jitter ?? 0.5, "jitter", 0);
  const cells = Math.ceil(source.terrainWidth / spacing); if (cells * cells > 1_000_000) scatterInvalid("grid exceeds 1000000 cells");
  const random = scatterRandom(options.seed ?? 0), { scale, yaw } = ranges(options), filters = options.filters ?? {}, out: number[] = [];
  validateFilters(filters);
  const policy=placementPolicy(source,options), mask=densityMask(options.mask, source);
  for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
    if ((x + 0.5) * spacing > source.terrainWidth || (z + 0.5) * spacing > source.terrainWidth) continue;
    const px = Math.max(0, Math.min(source.terrainWidth, (x + 0.5) * spacing + (random() - 0.5) * spacing * jitter));
    const pz = Math.max(0, Math.min(source.terrainWidth, (z + 0.5) * spacing + (random() - 0.5) * spacing * jitter));
    const [r, c] = source.contractToPixel(px+source.origin[0], pz+source.origin[1]);
    const p=source.pixelToContract(r,c);
    if (!policy.inside(p)) continue;
    if ((mask || policy.density !== 1) && random() > Math.max(0, Math.min(1, (mask ? sampleDensityMask(mask, source, r, c) : 1)*policy.density))) continue;
    if (!accepts(source, r, c, filters)) continue;
    if (!policy.acceptDistance(p)) continue;
    out.push(...makeScatterTransform(p, yaw[0] + random() * (yaw[1] - yaw[0]), scale[0] + random() * (scale[1] - scale[0])));
  }
  if (!out.length) scatterInvalid("grid generated zero accepted transforms");
  return new Float32Array(out);
}
