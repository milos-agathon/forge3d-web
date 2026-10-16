import { Forge3DError } from "./index.js";
import { finite, scatterInvalid } from "./scatter-mesh.js";
import type { TerrainScatterSource } from "./scatter-source.js";
import {
  getTerrainProbeMaterialDefaults,
  normalizeProbeLighting,
  type ProbeReflectionMaterial,
  type ProbeReflectionLighting,
} from "./probe-bake-options.js";
import { bakeProbeGridsInWorker } from "./probe-bake-worker-client.js";

export { getTerrainProbeMaterialDefaults } from "./probe-bake-options.js";
export type {
  ProbeReflectionMaterial,
  ProbeReflectionLighting,
} from "./probe-bake-options.js";

const MAX_IRRADIANCE_PROBES = 4096;
const MAX_REFLECTION_PROBES = 256;
const PROBE_BUFFER_HEADER_VECTORS = 8;
const IRRADIANCE_RECORD_VECTORS = 10;
const PROBE_BUFFER_ABI = 2;

export interface TerrainProbeGrid {
  origin: readonly [number, number];
  spacing: readonly [number, number];
  dims: readonly [number, number];
  heightOffset?: number;
  edgeBlend?: readonly [number, number];
}

export interface TerrainProbeBakeOptions {
  /** Irradiance grid. This retains the original combined-grid API name. */
  grid: TerrainProbeGrid;
  /** Optional native-shape reflection grid. Omission reuses `grid`. */
  reflectionGrid?: TerrainProbeGrid;
  skyColor?: readonly [number, number, number];
  skyIntensity?: number;
  rayCount?: number;
  maxTraceDistance?: number;
  /** Power of two in [1, 64]; native baking raises values below four to four. */
  reflectionResolution?: number;
  reflectionSamples?: number;
  terrainColor?: readonly [number, number, number];
  signal?: AbortSignal;
  reflectionMaterial?: Partial<ProbeReflectionMaterial>;
  reflectionLighting?: ProbeReflectionLighting;
  /** CPU bake output admission; defaults to 64 MiB. GPU commits use the runtime ledger. */
  memoryBudgetBytes?: number;
}

export interface TerrainProbeSnapshot {
  /** World-space terrain bounds used by native reflection box projection. */
  sceneBounds?: { min: readonly [number,number,number]; max: readonly [number,number,number] };
  /** Irradiance grid and positions; legacy combined snapshots retain this shape. */
  grid: Required<TerrainProbeGrid>;
  positions: Float32Array;
  /** Probe-major: nine native z-up SH L2 basis coefficients, packed RGB. */
  coefficients: Float32Array;
  /** Paired additive fields for an independent reflection grid. */
  reflectionGrid?: Required<TerrainProbeGrid>;
  reflectionPositions?: Float32Array;
  reflectionResolution: number;
  reflectionMips: Float32Array[];
  strength: number;
  reflectionStrength: number;
  debug: "none" | "irradiance" | "reflections" | "weight";
}

export interface TerrainProbeMemoryReport {
  /** Legacy field: number of irradiance probes. */
  probeCount: number;
  irradianceProbeCount: number;
  reflectionProbeCount: number;
  coefficientBytes: number;
  reflectionBytes: number;
  /** Bytes owned by snapshot position fields; legacy snapshots own one shared field. */
  positionBytes: number;
  irradiancePositionBytes: number;
  reflectionPositionBytes: number;
  gpuBytes: number;
}

export function probeShBasis(
  direction: readonly [number, number, number],
): number[] {
  // Public directions use y-up; baseline coefficients are z-up.
  const [x, z, y] = direction;
  return [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}

function normalize(v: number[]): [number, number, number] {
  const length = Math.hypot(...v);
  return v.map((x) => x / Math.max(length, 1e-12)) as [
    number,
    number,
    number,
  ];
}

function sample(
  source: TerrainScatterSource,
  x: number,
  z: number,
): number | undefined {
  if (
    x < source.origin[0] ||
    z < source.origin[1] ||
    x > source.origin[0] + source.terrainWidth ||
    z > source.origin[1] + source.terrainWidth
  ) {
    return undefined;
  }
  const [row, column] = source.contractToPixel(x, z);
  return source.sampleScaledHeight(row, column);
}

export function probeCubeDirection(
  face: number,
  u: number,
  v: number,
): [number, number, number] {
  const directions = [
    [1, -v, -u],
    [-1, -v, u],
    [u, 1, v],
    [u, -1, -v],
    [u, -v, 1],
    [-u, -v, -1],
  ];
  if (!directions[face]) scatterInvalid("cubemap face must be in [0, 5]");
  const [x, y, z] = normalize(directions[face]!);
  return [x, z, y];
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Forge3DError("REQUEST_CANCELLED", "probe bake cancelled");
  }
}

function positionsForGrid(
  source: TerrainScatterSource,
  grid: Required<TerrainProbeGrid>,
): Float32Array {
  const count = grid.dims[0] * grid.dims[1];
  const positions = new Float32Array(count * 3);
  for (let probe = 0; probe < count; probe += 1) {
    const x = grid.origin[0] + (probe % grid.dims[0]) * grid.spacing[0];
    const z =
      grid.origin[1] + Math.floor(probe / grid.dims[0]) * grid.spacing[1];
    const height = sample(source, x, z);
    if (height === undefined) scatterInvalid("probe grid must lie over the terrain");
    positions.set([x, height + grid.heightOffset, z], probe * 3);
  }
  return positions;
}

export class TerrainLightingProbes {
  #value: TerrainProbeSnapshot | undefined;

  constructor(snapshot: TerrainProbeSnapshot) {
    validateProbeSnapshot(snapshot);
    this.#value = structuredClone(snapshot);
  }

  static async bake(
    source: TerrainScatterSource,
    options: TerrainProbeBakeOptions,
  ): Promise<TerrainLightingProbes> {
    checkAbort(options.signal);
    const grid = normalizeProbeGrid(options.grid);
    const reflectionGrid = normalizeGrid(
      options.reflectionGrid ?? options.grid,
      MAX_REFLECTION_PROBES,
      "reflection probe",
    );
    const irradianceCount = grid.dims[0] * grid.dims[1];
    const reflectionCount = reflectionGrid.dims[0] * reflectionGrid.dims[1];
    const sky = options.skyColor ?? [0.6, 0.75, 1];
    if (sky.length !== 3) scatterInvalid("skyColor requires RGB");
    sky.forEach((x) => finite(x, "skyColor", 0));
    const intensity = finite(options.skyIntensity ?? 1, "skyIntensity", 0);
    const rays = options.rayCount ?? 64;
    const maxDistance = finite(
      options.maxTraceDistance ?? source.terrainWidth / 2,
      "maxTraceDistance",
      Number.MIN_VALUE,
    );
    if (!Number.isInteger(rays) || rays < 1 || rays > 4096) {
      scatterInvalid("rayCount must be in [1, 4096]");
    }
    const requestedResolution = options.reflectionResolution ?? 8;
    const resolution = Math.max(4, requestedResolution);
    const samples = options.reflectionSamples ?? 32;
    if (
      !Number.isInteger(requestedResolution) ||
      requestedResolution < 1 ||
      requestedResolution > 64 ||
      (requestedResolution & (requestedResolution - 1)) !== 0
    ) {
      scatterInvalid("reflectionResolution must be a power of two in [1, 64]");
    }
    if (!Number.isInteger(samples) || samples < 1 || samples > 256) {
      scatterInvalid("reflectionSamples must be in [1, 256]");
    }
    const terrainColor = options.terrainColor ?? [0.3, 0.4, 0.2];
    if (terrainColor.length !== 3) scatterInvalid("terrainColor requires RGB");
    terrainColor.forEach((x) => finite(x, "terrainColor", 0));
    const mipTexels =
      Array.from(
        { length: Math.log2(resolution) + 1 },
        (_, level) => (resolution >> level) ** 2,
      ).reduce((left, right) => left + right, 0) *
      6 *
      reflectionCount;
    const packedBytes =
      (PROBE_BUFFER_HEADER_VECTORS +
        irradianceCount * IRRADIANCE_RECORD_VECTORS +
        reflectionCount +
        mipTexels) *
      16;
    const budget = finite(
      options.memoryBudgetBytes ?? 64 * 1024 * 1024,
      "memoryBudgetBytes",
      1,
    );
    if (packedBytes > budget) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "probe bake output exceeds memoryBudgetBytes",
      );
    }
    const reflectionMaterial = {
      ...getTerrainProbeMaterialDefaults(terrainColor),
      ...options.reflectionMaterial,
    };
    const reflectionLighting = normalizeProbeLighting(
      options.reflectionLighting,
      intensity,
    );
    const positions = positionsForGrid(source, grid);
    const reflectionPositions =
      options.reflectionGrid === undefined
        ? positions.slice()
        : positionsForGrid(source, reflectionGrid);
    checkAbort(options.signal);
    const result = await bakeProbeGridsInWorker(
      {
        heights: Float32Array.from(
          source.heights,
          (height) => (height - source.minHeight) * source.zScale,
        ),
        width: source.width,
        height: source.height,
        terrainWidth: source.terrainWidth,
        terrainOrigin: source.origin,
        irradiancePositions: positions.slice(),
        reflectionPositions: reflectionPositions.slice(),
        skyColor: sky,
        skyIntensity: intensity,
        rayCount: rays,
        maxTraceDistance: maxDistance,
        reflectionResolution: resolution,
        reflectionSamples: samples,
        terrainColor,
        reflectionMaterial,
        reflectionLighting,
      },
      options.signal,
    );
    checkAbort(options.signal);
    const snapshot: TerrainProbeSnapshot = {
      sceneBounds: { min: [source.origin[0],0,source.origin[1]], max: [source.origin[0]+source.terrainWidth,(source.maxHeight-source.minHeight)*source.zScale,source.origin[1]+source.terrainWidth] },
      grid,
      positions,
      coefficients: result.coefficients,
      reflectionResolution: resolution,
      reflectionMips: result.reflectionMips,
      strength: 1,
      reflectionStrength: 1,
      debug: "none",
      ...(options.reflectionGrid === undefined
        ? {}
        : { reflectionGrid, reflectionPositions }),
    };
    return new TerrainLightingProbes(snapshot);
  }

  get disposed(): boolean {
    return this.#value === undefined;
  }

  snapshot(): TerrainProbeSnapshot {
    if (!this.#value) {
      throw new Forge3DError("RUNTIME_DISPOSED", "lighting probes disposed");
    }
    return structuredClone(this.#value);
  }

  setStrength(irradiance: number, reflection = irradiance): void {
    const value = this.snapshot();
    value.strength = finite(irradiance, "strength", 0, 1);
    value.reflectionStrength = finite(
      reflection,
      "reflectionStrength",
      0,
      1,
    );
    this.#value = value;
  }

  setDebug(debug: TerrainProbeSnapshot["debug"]): void {
    const value = this.snapshot();
    if (!["none", "irradiance", "reflections", "weight"].includes(debug)) {
      scatterInvalid("invalid probe debug mode");
    }
    value.debug = debug;
    this.#value = value;
  }

  memoryReport(): TerrainProbeMemoryReport {
    const value = this.snapshot();
    const reflection = reflectionPayload(value);
    return {
      probeCount: value.positions.length / 3,
      irradianceProbeCount: value.positions.length / 3,
      reflectionProbeCount: reflection.positions.length / 3,
      coefficientBytes: value.coefficients.byteLength,
      reflectionBytes: value.reflectionMips.reduce(
        (total, mip) => total + mip.byteLength,
        0,
      ),
      positionBytes:
        value.positions.byteLength +
        (value.reflectionPositions?.byteLength ?? 0),
      irradiancePositionBytes: value.positions.byteLength,
      reflectionPositionBytes: reflection.positions.byteLength,
      gpuBytes: packTerrainProbes(value).byteLength,
    };
  }

  dispose(): void {
    this.#value = undefined;
  }
}

export function normalizeProbeGrid(
  input: TerrainProbeGrid,
): Required<TerrainProbeGrid> {
  return normalizeGrid(input, MAX_IRRADIANCE_PROBES, "irradiance probe");
}

function normalizeGrid(
  input: TerrainProbeGrid,
  maxCount: number,
  name: string,
): Required<TerrainProbeGrid> {
  if (
    !input ||
    input.origin?.length !== 2 ||
    input.spacing?.length !== 2 ||
    input.dims?.length !== 2
  ) {
    scatterInvalid(`${name} grid requires origin, spacing and dims pairs`);
  }
  input.origin.forEach((x) => finite(x, `${name} origin`));
  input.spacing.forEach((x) =>
    finite(x, `${name} spacing`, Number.MIN_VALUE),
  );
  input.dims.forEach((x) => {
    if (!Number.isInteger(x) || x < 1 || x > maxCount) {
      scatterInvalid(`${name} dimensions must be positive integers`);
    }
  });
  if (input.dims[0] * input.dims[1] > maxCount) {
    scatterInvalid(`${name} count exceeds ${maxCount}`);
  }
  const edgeBlend = input.edgeBlend ?? [input.spacing[0], input.spacing[1]];
  if (edgeBlend.length !== 2) scatterInvalid(`${name} edgeBlend requires a pair`);
  edgeBlend.forEach((x) =>
    finite(x, `${name} edgeBlend`, Number.MIN_VALUE),
  );
  return {
    origin: [...input.origin],
    spacing: [...input.spacing],
    dims: [...input.dims],
    heightOffset: finite(
      input.heightOffset ?? 5,
      `${name} heightOffset`,
      Number.MIN_VALUE,
    ),
    edgeBlend: [...edgeBlend],
  };
}

function reflectionPayload(input: TerrainProbeSnapshot): {
  grid: Required<TerrainProbeGrid>;
  positions: Float32Array;
} {
  const hasGrid = input.reflectionGrid !== undefined;
  const hasPositions = input.reflectionPositions !== undefined;
  if (hasGrid !== hasPositions) {
    scatterInvalid(
      "reflectionGrid and reflectionPositions must be provided together",
    );
  }
  if (!hasGrid) return { grid: input.grid, positions: input.positions };
  return {
    grid: input.reflectionGrid!,
    positions: input.reflectionPositions!,
  };
}

export function validateProbeSnapshot(input: TerrainProbeSnapshot): void {
  if(input.sceneBounds){const b=input.sceneBounds;if(b.min.length!==3||b.max.length!==3)scatterInvalid("sceneBounds must contain xyz pairs");for(let a=0;a<3;a++){finite(b.min[a]!,"sceneBounds min");finite(b.max[a]!,"sceneBounds max");if(b.min[a]!>b.max[a]!)scatterInvalid("sceneBounds must be ordered");}}

  const grid = normalizeProbeGrid(input.grid);
  const irradianceCount = grid.dims[0] * grid.dims[1];
  const reflection = reflectionPayload(input);
  const reflectionGrid = normalizeGrid(
    reflection.grid,
    MAX_REFLECTION_PROBES,
    "reflection probe",
  );
  const reflectionCount = reflectionGrid.dims[0] * reflectionGrid.dims[1];
  if (
    input.positions.length !== irradianceCount * 3 ||
    input.coefficients.length !== irradianceCount * 27
  ) {
    scatterInvalid("irradiance probe placement/coefficient dimensions mismatch");
  }
  if (reflection.positions.length !== reflectionCount * 3) {
    scatterInvalid("reflection probe placement dimensions mismatch");
  }
  const size = input.reflectionResolution;
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 64 ||
    (size & (size - 1)) !== 0 ||
    input.reflectionMips.length !== Math.log2(size) + 1
  ) {
    scatterInvalid("reflection mip dimensions mismatch");
  }
  for (let level = 0; level < input.reflectionMips.length; level += 1) {
    if (
      input.reflectionMips[level]!.length !==
      reflectionCount * 6 * (size >> level) ** 2 * 4
    ) {
      scatterInvalid("reflection mip texel count mismatch");
    }
  }
  const fields = new Set<Float32Array>([
    input.positions,
    reflection.positions,
    input.coefficients,
    ...input.reflectionMips,
  ]);
  for (const field of fields) {
    if (!(field instanceof Float32Array)) {
      scatterInvalid("probe data must be Float32Array");
    }
    field.forEach((x) => finite(x, "probe value"));
  }
  finite(input.strength, "strength", 0, 1);
  finite(input.reflectionStrength, "reflectionStrength", 0, 1);
  if (!["none", "irradiance", "reflections", "weight"].includes(input.debug)) {
    scatterInvalid("invalid probe debug mode");
  }
}

/**
 * W09 probe storage ABI v2: eight header vectors, ten vectors per irradiance
 * probe, one position vector per reflection probe, then mip-major cubemaps.
 */
export function packTerrainProbes(value: TerrainProbeSnapshot): Float32Array {
  validateProbeSnapshot(value);
  const reflection = reflectionPayload(value);
  const irradianceCount = value.positions.length / 3;
  const reflectionCount = reflection.positions.length / 3;
  const irradianceOffset = PROBE_BUFFER_HEADER_VECTORS;
  const reflectionPositionOffset =
    irradianceOffset + irradianceCount * IRRADIANCE_RECORD_VECTORS;
  const reflectionMipOffset = reflectionPositionOffset + reflectionCount;
  const length =
    reflectionMipOffset * 4 +
    value.reflectionMips.reduce((total, mip) => total + mip.length, 0);
  const out = new Float32Array(length);
  out.set([
    value.grid.origin[0],
    value.grid.origin[1],
    value.grid.spacing[0],
    value.grid.spacing[1],
    value.grid.dims[0],
    value.grid.dims[1],
    value.strength,
    value.reflectionStrength,
    value.grid.edgeBlend[0],
    value.grid.edgeBlend[1],
    value.reflectionResolution,
    value.reflectionMips.length,
    irradianceCount,
    ["none", "irradiance", "reflections", "weight"].indexOf(value.debug),
    reflectionCount,
    PROBE_BUFFER_ABI,
    reflection.grid.origin[0],
    reflection.grid.origin[1],
    reflection.grid.spacing[0],
    reflection.grid.spacing[1],
    reflection.grid.dims[0],
    reflection.grid.dims[1],
    reflection.grid.edgeBlend[0],
    reflection.grid.edgeBlend[1],
    irradianceOffset,
    reflectionPositionOffset,
    reflectionMipOffset,
    0,
    0,
    0,
    0,
    0,
  ]);
  if(value.sceneBounds){const b=value.sceneBounds;out.set([b.min[1],b.max[1],b.max[0]-b.min[0],b.max[2]-b.min[2]],28);}
  for (let probe = 0; probe < irradianceCount; probe += 1) {
    const record = (irradianceOffset + probe * IRRADIANCE_RECORD_VECTORS) * 4;
    out.set(value.positions.subarray(probe * 3, probe * 3 + 3), record);
    for (let coefficient = 0; coefficient < 9; coefficient += 1) {
      const source = probe * 27 + coefficient * 3;
      out.set(
        value.coefficients.subarray(source, source + 3),
        record + (coefficient + 1) * 4,
      );
    }
  }
  for (let probe = 0; probe < reflectionCount; probe += 1) {
    out.set(
      reflection.positions.subarray(probe * 3, probe * 3 + 3),
      (reflectionPositionOffset + probe) * 4,
    );
  }
  let offset = reflectionMipOffset * 4;
  for (const mip of value.reflectionMips) {
    out.set(mip, offset);
    offset += mip.length;
  }
  return out;
}
