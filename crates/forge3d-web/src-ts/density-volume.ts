import { Forge3DError } from "./index.js";
import {
  normalizeEnvironment,
  type DensityVolumeInput,
} from "./environment.js";
export interface DensityVolumePresetInput {
  preset: "valley_fog" | "plume" | "localized_haze";
  bounds: DensityVolumeInput["bounds"];
  dimensions?: [number, number, number];
  densityScale?: number;
  edgeSoftness?: number;
  noiseStrength?: number;
  floorOffset?: number;
  ceiling?: number;
  plumeSpread?: number;
  wind?: [number, number, number];
  seed?: number;
  color?: [number, number, number];
  anisotropy?: number;
  terrain?: {
    heights: Float32Array;
    width: number;
    height: number;
    bounds: [number, number, number, number];
    domainMin?: number;
    exaggeration?: number;
  };
}
export interface DensityVolumeGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};
function lattice(x: number, y: number, z: number, seed: number): number {
  let v =
    seed ^
    Math.imul(x, 0x9e3779b9) ^
    Math.imul(y, 0x85ebca6b) ^
    Math.imul(z, 0xc2b2ae35);
  v ^= v >>> 16;
  v = Math.imul(v, 0x7feb352d);
  v ^= v >>> 15;
  v = Math.imul(v, 0x846ca68b);
  v ^= v >>> 16;
  return (v >>> 0) / 4294967295;
}
function noise(p: number[], seed: number): number {
  const cell = p.map(Math.floor),
    w = p.map((x) => {
      const f = x - Math.floor(x);
      return f * f * (3 - 2 * f);
    });
  const plane = (z: number) =>
    lerp(
      lerp(
        lattice(cell[0]!, cell[1]!, z, seed),
        lattice(cell[0]! + 1, cell[1]!, z, seed),
        w[0]!,
      ),
      lerp(
        lattice(cell[0]!, cell[1]! + 1, z, seed),
        lattice(cell[0]! + 1, cell[1]! + 1, z, seed),
        w[0]!,
      ),
      w[1]!,
    );
  return lerp(plane(cell[2]!), plane(cell[2]! + 1), w[2]!);
}
function fbm(p: number[], seed: number): number {
  let sum = 0,
    norm = 0,
    frequency = 1,
    amplitude = 0.5;
  for (let octave = 0; octave < 3; octave++) {
    sum +=
      noise(
        p.map((x, axis) => x * frequency * [3.1, 2.3, 3.7][axis]!),
        (seed + octave * 811) >>> 0,
      ) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}
function check(value: number, lo: number, hi: number, name: string): number {
  if (!Number.isFinite(value) || value < lo || value > hi)
    throw new Forge3DError("INVALID_INPUT", name);
  return value;
}
/** Native TV6 density fields. Generation yields between slices and never mutates a scene. */
export async function generateDensityVolume(
  input: DensityVolumePresetInput,
  options: DensityVolumeGenerationOptions = {},
): Promise<DensityVolumeInput> {
  if (!["valley_fog", "plume", "localized_haze"].includes(input.preset))
    throw new Forge3DError("INVALID_INPUT", "density preset");
  const dimensions = input.dimensions ?? [16, 16, 16];
  if (dimensions.some((x) => !Number.isInteger(x) || x < 2 || x > 96))
    throw new Forge3DError("INVALID_INPUT", "density dimensions must be 2..96");
  const shape = normalizeEnvironment({
    volumes: [
      {
        bounds: input.bounds,
        dimensions: [1, 1, 1],
        color: input.color ?? [0.8, 0.8, 0.8],
        anisotropy: input.anisotropy ?? 0,
      },
    ],
  }).volumes[0]!;
  const scale = check(input.densityScale ?? 1, 0, 100, "density scale");
  const edge = check(input.edgeSoftness ?? 0.2, 0, 1, "edge softness");
  const strength = check(input.noiseStrength ?? 0.5, 0, 1, "noise strength");
  const floor = check(input.floorOffset ?? 0, -1e7, 1e7, "floor offset");
  const ceiling = check(input.ceiling ?? 0.6, 0, 1, "ceiling");
  const spread = check(input.plumeSpread ?? 0.7, 0, 10, "plume spread");
  const seed = check(input.seed ?? 0, 0, 4294967295, "density seed");
  if (!Number.isInteger(seed))
    throw new Forge3DError("INVALID_INPUT", "density seed must be integer");
  const wind = input.wind ?? [0, 1, 0];
  if (wind.length !== 3 || !wind.every(Number.isFinite))
    throw new Forge3DError("INVALID_INPUT", "density wind");
  const windLength = Math.hypot(...wind);
  const direction =
    windLength ** 2 < 1e-6 ? [0, 1, 0] : wind.map((x) => x / windLength);
  const terrain = input.terrain;
  if (terrain) {
    if (
      ![terrain.width, terrain.height].every(
        (x) => Number.isInteger(x) && x >= 2,
      ) ||
      terrain.heights.length !== terrain.width * terrain.height ||
      !terrain.heights.every(Number.isFinite) ||
      terrain.bounds.length !== 4 ||
      !terrain.bounds.every(Number.isFinite) ||
      terrain.bounds[0] >= terrain.bounds[2] ||
      terrain.bounds[1] >= terrain.bounds[3]
    )
      throw new Forge3DError("INVALID_INPUT", "density terrain");
    check(terrain.domainMin ?? 0, -1e7, 1e7, "domain min");
    check(terrain.exaggeration ?? 1, 0, 1e5, "exaggeration");
  }
  const terrainHeight = (x: number, z: number) => {
    if (!terrain) return 0;
    const b = terrain.bounds;
    const sx =
      Math.max(0, Math.min(1, (x - b[0]) / (b[2] - b[0]))) *
      (terrain.width - 1);
    const sz =
      Math.max(0, Math.min(1, (z - b[1]) / (b[3] - b[1]))) *
      (terrain.height - 1);
    const ix = Math.floor(sx),
      iz = Math.floor(sz);
    const at = (dx: number, dz: number) =>
      terrain.heights[
        Math.min(iz + dz, terrain.height - 1) * terrain.width +
          Math.min(ix + dx, terrain.width - 1)
      ]!;
    return (
      (lerp(
        lerp(at(0, 0), at(1, 0), sx - ix),
        lerp(at(0, 1), at(1, 1), sx - ix),
        sz - iz,
      ) -
        (terrain.domainMin ?? 0)) *
      (terrain.exaggeration ?? 1)
    );
  };
  const data = new Float32Array(dimensions[0] * dimensions[1] * dimensions[2]);
  const b = shape.bounds,
    size = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
  const box = (p: number[], softness: number) =>
    p.reduce((v, x) => {
      const w = Math.max(0.01, Math.min(0.49, softness * 0.5));
      return v * smooth(0, w, x) * (1 - smooth(1 - w, 1, x));
    }, 1);
  for (let z = 0; z < dimensions[2]; z++) {
    options.signal?.throwIfAborted();
    for (let y = 0; y < dimensions[1]; y++)
      for (let x = 0; x < dimensions[0]; x++) {
        const p = [
          x / (dimensions[0] - 1),
          y / (dimensions[1] - 1),
          z / (dimensions[2] - 1),
        ];
        const mix = lerp(1, 0.55 + 0.45 * fbm(p, seed), strength);
        let density: number;
        if (input.preset === "plume") {
          const progress = p[1]!;
          const distance = Math.hypot(
            p[0]! - (0.5 + direction[0]! * progress * 0.2),
            p[2]! - (0.5 + direction[2]! * progress * 0.2),
          );
          const radius = 0.12 + progress * spread * 0.35;
          density =
            box(p, edge * 0.7) *
            (1 - smooth(radius, radius * 1.85, distance)) *
            smooth(0.02, 0.16, progress) *
            (1 - smooth(0.82, 1, progress)) *
            mix;
        } else if (input.preset === "localized_haze") {
          const ellipsoid = Math.hypot(
            (p[0]! - 0.5) / 0.5,
            (p[1]! - ceiling) / 0.32,
            (p[2]! - 0.5) / 0.5,
          );
          density =
            box(p, edge) *
            Math.max(
              1 - smooth(0.55, 1.1, ellipsoid),
              (1 - smooth(0.25, 0.9, Math.abs(p[1]! - ceiling))) * 0.7,
            ) *
            mix;
        } else {
          const ground =
            terrainHeight(b[0] + size[0]! * p[0]!, b[2] + size[2]! * p[2]!) +
            floor;
          const above = Math.max(0, b[1] + size[1]! * p[1]! - ground);
          density =
            box(p, edge) *
            (1 -
              smooth(
                0,
                Math.max(1, size[1]! * Math.max(ceiling, 0.08)),
                above,
              )) *
            (1 - smooth(ceiling, 1, p[1]!)) *
            mix;
        }
        data[(z * dimensions[1] + y) * dimensions[0] + x] = Math.max(
          0,
          Math.min(1, density * scale * 0.028),
        );
      }
    options.onProgress?.((z + 1) / dimensions[2]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  options.signal?.throwIfAborted();
  return {
    bounds: [...b],
    dimensions: [...dimensions],
    density: 1,
    data,
    color: shape.color,
    anisotropy: shape.anisotropy,
  };
}
