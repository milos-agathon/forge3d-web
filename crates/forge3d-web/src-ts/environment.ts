import type {
  EnvironmentInput,
  EnvironmentSnapshot,
  EnvironmentMemoryReport,
} from "./environment-types.js";
import { num, fail } from "./environment-input.js";
import { sunPosition } from "./sun-position.js";
import { normalizeEnvironment } from "./environment-validation.js";
export type * from "./environment-types.js";
export { sunPosition, normalizeEnvironment };
export function environmentMemoryReport(
  snapshot: EnvironmentSnapshot,
  width: number,
  height: number,
): EnvironmentMemoryReport {
  [width, height].forEach((x) => {
    num(x, 1, 32768, "dimensions");
    if (!Number.isInteger(x)) fail("dimensions must be integer");
  });
  const s = normalizeEnvironment(snapshot);
  const effectWidth = Math.ceil(width * s.resolutionScale),
    effectHeight = Math.ceil(height * s.resolutionScale);
  const planar = s.water.filter((w) => w.reflection === "planar").length;
  const reflectionBytes =
    (planar ? width * height : 1) * 4 * (Math.max(1, s.water.length) + 1) +
    planar * 96 + (s.water.some(w => w.terrainMask) ? 96 : 0);
  const froxelBytes =
    s.volumetricMode === "froxel"
      ? Math.ceil(width / 8) * Math.ceil(height / 8) * s.steps * 8
      : 8;
  const gpuBytes =
    froxelBytes +
    reflectionBytes +
    width * height * 4 +
    effectWidth * effectHeight * 20 +
    (8 * 16 +
      4 * 48 +
      s.volumes.reduce((n, v) => n + v.data.length, 0) +
      s.water.reduce((n, w) => n + w.mask.length, 0)) *
      4 +
    512;
  return {
    gpuBytes,
    width,
    height,
    effectWidth,
    effectHeight,
    resolutionScale: s.resolutionScale,
    steps: s.steps,
    volumeCount: s.volumes.length,
    waterCount: s.water.length,
    historyValid: false,
  };
}
/** Serializable deterministic environment, with optional UTC time animation. */
export class Forge3DEnvironment {
  #snapshot: EnvironmentSnapshot;
  constructor(input: EnvironmentInput = {}) {
    this.#snapshot = normalizeEnvironment(input);
  }
  snapshot(timeSeconds = 0): EnvironmentSnapshot {
    num(timeSeconds, -1e12, 1e12, "time");
    const s = structuredClone(this.#snapshot);
    if (s.sunClock) {
      const c = s.sunClock;
      s.sunDirection = sunPosition(
        c.latitude,
        c.longitude,
        new Date(
          (c.unixSeconds + timeSeconds * c.timeScale) * 1000,
        ).toISOString(),
      ).direction;
    }
    return s;
  }
  copy(): Forge3DEnvironment {
    const c = new Forge3DEnvironment(this.#snapshot);
    return c;
  }
  memoryReport(width: number, height: number): EnvironmentMemoryReport {
    return environmentMemoryReport(this.snapshot(), width, height);
  }
}
