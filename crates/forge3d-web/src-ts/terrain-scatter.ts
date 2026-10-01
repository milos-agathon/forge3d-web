import { finite, scatterInvalid, validateScatterMesh, scatterMeshBounds, scatterTransformBounds, scatterTransformPoint, mergeScatterBounds, simplifyScatterMesh, recomputeScatterNormals } from "./scatter-mesh.js";
import type { ScatterBatchInput, ScatterBatchSnapshot, ScatterWindInput, ScatterWindSnapshot, ScatterBounds, ScatterCluster, ScatterFrameStats, ScatterMemoryReport } from "./scatter-types.js";
export type * from "./scatter-types.js";
export { makeScatterTransform, TerrainScatterSource, seededScatterTransforms, gridScatterTransforms, bilinearScatterSample } from "./scatter-source.js";
export { simplifyScatterMesh, autoScatterLodLevels, scatterMeshBounds, scatterTransformBounds } from "./scatter-mesh.js";

const WIND: ScatterWindSnapshot = { enabled: false, directionDegrees: 0, speed: 1, amplitude: 0, rigidity: 0.5, bendStart: 0, bendExtent: 1, gustStrength: 0, gustFrequency: 0.3, fadeStart: 0, fadeEnd: 0 };
export class ScatterWindSettings {
  readonly #value: ScatterWindSnapshot;
  constructor(input: ScatterWindInput = {}) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) scatterInvalid("wind must be an object");
    this.#value = { ...WIND, ...input };
    if (typeof this.#value.enabled !== "boolean") scatterInvalid("wind.enabled must be boolean");
    for (const [key, value] of Object.entries(this.#value)) if (key !== "enabled") finite(value as number, `wind.${key}`);
    const w = this.#value;
    for (const key of ["speed", "amplitude", "gustStrength", "gustFrequency", "fadeStart", "fadeEnd"] as const) finite(w[key], key, 0);
    finite(w.rigidity, "rigidity", 0, 1); finite(w.bendStart, "bendStart", 0, 1); finite(w.bendExtent, "bendExtent", Number.MIN_VALUE);
  }
  snapshot(): ScatterWindSnapshot { return { ...this.#value }; }
}
function validateTransform(t: Float32Array): void {
  t.forEach(x => finite(x, "transform"));
  if (t[12] !== 0 || t[13] !== 0 || t[14] !== 0 || t[15] !== 1) scatterInvalid("transforms must be affine row-major matrices");
  const det = t[0]! * (t[5]! * t[10]! - t[6]! * t[9]!) - t[1]! * (t[4]! * t[10]! - t[6]! * t[8]!) + t[2]! * (t[4]! * t[9]! - t[5]! * t[8]!);
  if (Math.abs(det) < 1e-12) scatterInvalid("transform linear matrix must be nonsingular");
}
function clusters(snapshot: ScatterBatchSnapshot): ScatterCluster[] {
  if (!snapshot.hlod) return [];
  const cells = new Map<string, number[]>(), radius = snapshot.hlod.clusterRadius;
  for (let i = 0; i < snapshot.transforms.length / 16; i++) {
    const key = `${Math.floor(snapshot.transforms[i * 16 + 3]! / radius)}:${Math.floor(snapshot.transforms[i * 16 + 11]! / radius)}`;
    const cell = cells.get(key); if (cell) cell.push(i); else cells.set(key, [i]);
  }
  const source = snapshot.levels[snapshot.levels.length - 1]!.mesh;
  return [...cells.values()].map(ids => {
    const positions: number[] = [], indices: number[] = [], allBounds: ScatterBounds[] = [];
    for (const id of ids) {
      const m = snapshot.transforms.subarray(id * 16, id * 16 + 16), offset = positions.length / 3;
      for (let i = 0; i < source.positions.length; i += 3) positions.push(...scatterTransformPoint(m, source.positions.subarray(i, i + 3)));
      for (const index of source.indices) indices.push(index + offset);
      // Bounds cover the original instance, every LOD and potential animated displacement.
      allBounds.push(instanceBounds(snapshot, id));
    }
    const mesh = { positions: new Float32Array(positions), normals: new Float32Array(positions.length), indices: new Uint32Array(indices) };
    recomputeScatterNormals(mesh);
    const bounds = mergeScatterBounds(allBounds), center = bounds.min.map((x, a) => (x + bounds.max[a]!) / 2) as [number, number, number];
    return { mesh: simplifyScatterMesh(mesh, snapshot.hlod!.simplifyRatio), instanceIndices: ids, bounds, center, radius: Math.hypot(...bounds.max.map((x, a) => x - center[a]!)) };
  });
}
function instanceBounds(snapshot: ScatterBatchSnapshot, id: number): ScatterBounds {
  const m = snapshot.transforms.subarray(id * 16, id * 16 + 16);
  const bounds = mergeScatterBounds(snapshot.levels.map(l => scatterTransformBounds(scatterMeshBounds(l.mesh), m)));
  if (snapshot.wind.enabled && snapshot.wind.amplitude > 0) {
    const maximum = snapshot.wind.amplitude * (1 - snapshot.wind.rigidity) + snapshot.wind.gustStrength;
    for (let a = 0; a < 3; a++) {
      const slack = maximum * Math.hypot(m[a * 4]!, m[a * 4 + 2]!);
      bounds.min[a] = bounds.min[a]! - slack; bounds.max[a] = bounds.max[a]! + slack;
    }
  }
  return bounds;
}
export class TerrainScatterBatch {
  readonly #value: ScatterBatchSnapshot;
  constructor(input: ScatterBatchInput) {
    if (!input || !Array.isArray(input.levels) || !input.levels.length || input.levels.length > 32) scatterInvalid("batch requires 1..32 LODs");
    if (!(input.transforms instanceof Float32Array) || !input.transforms.length || input.transforms.length % 16) scatterInvalid("transforms must be nonempty N*16 Float32Array");
    if (input.transforms.length / 16 > 1_000_000) scatterInvalid("batch exceeds 1000000 instances");
    let distance = 0;
    const levels = input.levels.map((level, index) => {
      const mesh = validateScatterMesh(level.mesh);
      if (level.maxDistance === undefined) { if (index !== input.levels.length - 1) scatterInvalid("only the final LOD may be open-ended"); return { mesh }; }
      const maxDistance = finite(level.maxDistance, "maxDistance", Number.MIN_VALUE);
      if (maxDistance <= distance) scatterInvalid("LOD distances must increase"); distance = maxDistance;
      return { mesh, maxDistance };
    });
    const transforms = input.transforms.slice(); for (let i = 0; i < transforms.length; i += 16) validateTransform(transforms.subarray(i, i + 16));
    const color = [...(input.color ?? [0.85, 0.85, 0.85, 1])] as [number, number, number, number];
    if (color.length !== 4) scatterInvalid("color requires RGBA"); color.forEach(x => finite(x, "color", 0));
    const maxDrawDistance = input.maxDrawDistance === undefined ? null : finite(input.maxDrawDistance, "maxDrawDistance", Number.MIN_VALUE);
    const hlod = input.hlod ? { distance: finite(input.hlod.distance, "hlod.distance", Number.MIN_VALUE), clusterRadius: finite(input.hlod.clusterRadius, "hlod.clusterRadius", Number.MIN_VALUE), simplifyRatio: finite(input.hlod.simplifyRatio ?? 0.1, "hlod.simplifyRatio", Number.MIN_VALUE, 1) } : null;
    if (hlod && maxDrawDistance !== null && hlod.distance >= maxDrawDistance) scatterInvalid("HLOD distance must be below maxDrawDistance");
    const terrainBlend = { enabled: false, buryDepth: 0.75, fadeDistance: 2.5, ...input.terrainBlend };
    const terrainContact = { enabled: false, distance: 3, strength: 0.35, verticalWeight: 0.65, ...input.terrainContact };
    if (typeof terrainBlend.enabled !== "boolean" || typeof terrainContact.enabled !== "boolean") scatterInvalid("blend/contact enabled must be boolean");
    finite(terrainBlend.buryDepth, "buryDepth", 0); finite(terrainBlend.fadeDistance, "fadeDistance", Number.MIN_VALUE);
    finite(terrainContact.distance, "contact distance", Number.MIN_VALUE); finite(terrainContact.strength, "contact strength", 0, 1); finite(terrainContact.verticalWeight, "verticalWeight", 0, 1);
    this.#value = { levels, transforms, color, maxDrawDistance, hlod, terrainBlend, terrainContact, name: input.name ?? "scatter", wind: new ScatterWindSettings(input.wind).snapshot(), bounds: { min: [0, 0, 0], max: [0, 0, 0] }, clusters: [] };
    this.#value.bounds = mergeScatterBounds(Array.from({ length: transforms.length / 16 }, (_, id) => instanceBounds(this.#value, id)));
    this.#value.clusters = clusters(this.#value);
  }
  get instanceCount(): number { return this.#value.transforms.length / 16; }
  snapshot(): ScatterBatchSnapshot { return structuredClone(this.#value); }
  instanceBounds(id: number): ScatterBounds {
    if (!Number.isInteger(id) || id < 0 || id >= this.instanceCount) scatterInvalid("instance ID out of range");
    return instanceBounds(this.#value, id);
  }
  memoryReport(): ScatterMemoryReport { return scatterMemoryReport([this.#value]); }
}
export function scatterMemoryReport(batches: readonly ScatterBatchSnapshot[]): ScatterMemoryReport {
  const report: ScatterMemoryReport = { batchCount: batches.length, levelCount: 0, totalInstances: 0, vertexBufferBytes: 0, indexBufferBytes: 0, instanceBufferBytes: 0, hlodClusterCount: 0, hlodBufferBytes: 0, uniformBufferBytes: batches.length ? 256 : 0, totalBufferBytes: 0, textureBytes: batches.length ? 8 : 0, gpuBytes: 0 };
  for (const batch of batches) {
    report.levelCount += batch.levels.length; report.totalInstances += batch.transforms.length / 16;
    // LitVertex is 72 bytes; each instance has a matrix and a 16-byte metadata vector.
    for (const l of batch.levels) { report.vertexBufferBytes += l.mesh.positions.length / 3 * 72; report.indexBufferBytes += l.mesh.indices.byteLength; report.instanceBufferBytes += batch.transforms.length / 16 * 80; report.uniformBufferBytes += 128; }
    report.hlodClusterCount += batch.clusters.length;
    for (const c of batch.clusters) { report.hlodBufferBytes += c.mesh.positions.length / 3 * 72 + c.mesh.indices.byteLength + 80; report.uniformBufferBytes += 128; }
  }
  report.totalBufferBytes = report.vertexBufferBytes + report.indexBufferBytes + report.instanceBufferBytes + report.hlodBufferBytes + report.uniformBufferBytes;
  report.gpuBytes = report.totalBufferBytes + report.textureBytes;
  return report;
}

/** Revalidate and take ownership before a scene, viewer or runtime retains data. */
export function normalizeScatterBatches(inputs: readonly (TerrainScatterBatch | ScatterBatchInput | ScatterBatchSnapshot)[]): ScatterBatchSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length > 256) scatterInvalid("scatter requires an array of at most 256 batches");
  return inputs.map(input => {
    if (input instanceof TerrainScatterBatch) return input.snapshot();
    const { maxDrawDistance, hlod, ...rest } = input;
    return new TerrainScatterBatch({ ...rest, ...(maxDrawDistance != null ? { maxDrawDistance } : {}), ...(hlod != null ? { hlod } : {}) }).snapshot();
  });
}
export function selectScatterLods(batches: readonly ScatterBatchSnapshot[], eye: readonly [number, number, number]): ScatterFrameStats {
  eye.forEach(x => finite(x, "eye"));
  const stats: ScatterFrameStats = { batchCount: batches.length, totalInstances: 0, visibleInstances: 0, culledInstances: 0, lodInstanceCounts: [], hlodClusterDraws: 0, hlodCoveredInstances: 0, effectiveDraws: 0 };
  for (const b of batches) {
    const covered = new Set<number>(), counts = b.levels.map(() => 0);
    for (const c of b.clusters) if (Math.hypot(...c.center.map((x, a) => x - eye[a]!)) - c.radius > b.hlod!.distance && c.instanceIndices.every(id => Math.hypot(b.transforms[id * 16 + 3]! - eye[0], b.transforms[id * 16 + 7]! - eye[1], b.transforms[id * 16 + 11]! - eye[2]) <= (b.maxDrawDistance ?? Infinity))) {
      c.instanceIndices.forEach(id => covered.add(id)); stats.hlodClusterDraws++; stats.effectiveDraws++;
    }
    for (let i = 0; i < b.transforms.length / 16; i++) {
      stats.totalInstances++;
      const d = Math.hypot(b.transforms[i * 16 + 3]! - eye[0], b.transforms[i * 16 + 7]! - eye[1], b.transforms[i * 16 + 11]! - eye[2]);
      if (d > (b.maxDrawDistance ?? Infinity)) { stats.culledInstances++; continue; }
      stats.visibleInstances++; if (covered.has(i)) { stats.hlodCoveredInstances++; continue; }
      let level = b.levels.findIndex(l => d <= (l.maxDistance ?? Infinity)); if (level < 0) level = b.levels.length - 1;
      counts[level] = counts[level]! + 1;
    }
    counts.forEach((count, i) => { stats.lodInstanceCounts[i] = (stats.lodInstanceCounts[i] ?? 0) + count; if (count) stats.effectiveDraws++; });
  }
  return stats;
}
