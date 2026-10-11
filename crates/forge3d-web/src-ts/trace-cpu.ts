import type {
  TraceCamera,
  TraceVec3,
  TraceResult,
  TraceTraversalMode,
} from "./trace-types.js";
import { TraceScene } from "./trace-scene.js";
import {
  TraceRng,
  sampleSeed,
  add,
  sub,
  mul,
  had,
  dot,
  cross,
  unit,
  length,
  f,
  clamp,
  luminance,
  boundsInterval,
  ray,
} from "./trace-math.js";
import {
  AliasTable,
  cosineDirection,
  sampleHg,
  localToWorld,
  emptyReservoir,
  updateReservoir,
  mergeReservoir,
  reservoirWeight,
} from "./trace-sampling.js";
import type {
  RestirConfig,
  TraceReservoir,
  OnlineGuidingGrid,
} from "./trace-sampling.js";
import { sampleTraceLight } from "./trace-light.js";
import { sampleGgx, sampleDielectric, mediumRatio } from "./trace-bsdf.js";
export interface CpuTraceSettings {
  width: number;
  height: number;
  seed: number;
  maxBounces: number;
  camera: Required<TraceCamera>;
  mode: TraceTraversalMode;
  clamp: number;
  restir: RestirConfig | undefined;
  guiding: OnlineGuidingGrid | undefined;
}
export function emptyTraceResult(
  width: number,
  height: number,
  samples = 0,
): TraceResult {
  const n = width * height,
    a = () => new Float32Array(n * 3),
    b = () => new Float32Array(n);
  return {
    width,
    height,
    samples,
    color: a(),
    albedo: a(),
    normal: a(),
    depth: b(),
    id: new Uint32Array(n),
    direct: a(),
    indirect: a(),
    emission: a(),
    visibility: b(),
    ao: b(),
    bentNormal: a(),
    variance: b(),
  };
}
export function cameraRay(
  s: CpuTraceSettings,
  pixel: number,
  rng: TraceRng,
): { origin: TraceVec3; direction: TraceVec3 } {
  const forward = unit(sub(s.camera.target, s.camera.origin)),
    right = unit(cross(forward, s.camera.up)),
    up = cross(right, forward),
    scale = f(Math.tan((s.camera.fovY * Math.PI) / 360));
  const x = f(f(f((pixel % s.width) + rng.next()) / s.width) * 2 - 1),
    y = f(1 - f(f(Math.floor(pixel / s.width) + rng.next()) / s.height) * 2);
  return {
    origin: s.camera.origin,
    direction: unit(
      add(
        add(forward, mul(right, f(f(x * scale) * f(s.width / s.height)))),
        mul(up, f(y * scale)),
      ),
    ),
  };
}
const reflect = (d: TraceVec3, n: TraceVec3): TraceVec3 =>
  sub(d, mul(n, f(2 * dot(d, n))));
function lightContribution(
  scene: TraceScene,
  index: number,
  p: TraceVec3,
  n: TraceVec3,
  albedo: TraceVec3,
  mode: TraceTraversalMode,
  u = 0,
  v = 0,
): TraceVec3 {
  const l = sampleTraceLight(scene.lights[index]!, p, u, v),
    cos = Math.max(0, dot(n, l.direction));
  if (!cos || l.distance < 1e-4) return [0, 0, 0];
  return mul(had(albedo, l.radiance), f(cos / Math.PI));
}
export function traceCpuSample(
  scene: TraceScene,
  s: CpuTraceSettings,
  pixel: number,
  sample: number,
  reservoirs: TraceReservoir[],
): {
  record: Float32Array;
  reservoir: TraceReservoir;
  guidingBin: number | undefined;
  guidingWeight: number | undefined;
} {
  const rng = new TraceRng(sampleSeed(s.seed, pixel, sample)),
    initial = cameraRay(s, pixel, rng),
    record = new Float32Array(28),
    bits = new Uint32Array(record.buffer);
  let origin = initial.origin,
    direction = initial.direction,
    throughput: TraceVec3 = [1, 1, 1],
    beauty: TraceVec3 = [0, 0, 0],
    direct: TraceVec3 = [0, 0, 0],
    indirect: TraceVec3 = [0, 0, 0],
    emission: TraceVec3 = [0, 0, 0],
    reservoir = emptyReservoir(),
    primaryReservoir = emptyReservoir();
  let guidingBin: number | undefined, guidingWeight: number | undefined;
  for (let bounce = 0; bounce < s.maxBounces; bounce++) {
    const hit = scene.intersect({ origin, direction }, s.mode);
    const m = scene.medium;
    if (m) {
      const interval = boundsInterval(
        m.bounds,
        ray({ origin, direction, tMax: hit?.t ?? 1e30 }),
      );
      if (interval) {
        const sigma = add(m.sigmaA, m.sigmaS),
          majorant = Math.max(...sigma),
          flight =
            majorant > 0
              ? f(-Math.log(Math.max(1e-7, 1 - rng.next())) / majorant)
              : Infinity,
          span = f(interval[1] - interval[0]);
        if (flight < span) {
          const distance = f(interval[0] + flight);
          origin = add(origin, mul(direction, distance));
          throughput = had(
            throughput,
            had(
              mediumRatio(sigma, majorant, flight),
              mul(m.sigmaS, 1 / Math.max(majorant, 1e-30)),
            ),
          );
          direction = localToWorld(
            sampleHg(rng.next(), rng.next(), m.g ?? 0).direction,
            direction,
          );
          continue;
        }
        throughput = had(throughput, mediumRatio(sigma, majorant, span));
        // Analog free-flight sampling already accounts for transmittance; no second Beer factor.
      }
    }
    if (!hit) {
      const sky = mul(
          scene.environment,
          f(0.5 + 0.5 * Math.max(0, direction[1])),
        ),
        c = had(throughput, sky);
      beauty = add(beauty, c);
      indirect = add(indirect, c);
      break;
    }
    const material = scene.materials[hit.materialId]!,
      p = hit.position,
      n = hit.normal;
    const emitted = had(throughput, material.emission);
    beauty = add(beauty, emitted);
    emission = add(emission, emitted);
    if (bounce === 0) {
      record.set(material.albedo, 4);
      bits[7] = hit.id;
      record.set(n, 8);
      record[11] = hit.t;
      record[15] = 1;
      const aoDir = cosineDirection(rng.next(), rng.next(), n),
        occluded = scene.intersect(
          { origin: add(p, mul(n, 1e-4)), direction: aoDir, tMax: 1 },
          s.mode,
        );
      record[19] = occluded ? 0 : 1;
      record.set(occluded ? [0, 0, 0] : aoDir, 24);
    }
    let lighting: TraceVec3 = [0, 0, 0],
      lightIndex = 0,
      lightU = 0,
      lightV = 0;
    if (scene.lights.length) {
      reservoir = emptyReservoir();
      const choose = () => {
        const u = rng.next(),
          v = rng.next();
        const total = scene.lights.reduce((s, l) => s + l.weight, 0);
        let remaining = u * total;
        for (let i = 0; i < scene.lights.length; i++) {
          remaining -= scene.lights[i]!.weight;
          if (remaining < 0 || i + 1 === scene.lights.length)
            return {
              index: i,
              pdf: scene.lights[i]!.weight / total,
              u: clamp(
                (remaining + scene.lights[i]!.weight) / scene.lights[i]!.weight,
              ),
              v,
            };
        }
        return { index: 0, pdf: 1, u: 0, v };
      };
      if (s.restir) {
        for (let i = 0; i < s.restir.initialCandidates; i++) {
          const candidate = choose(),
            value = lightContribution(
              scene,
              candidate.index,
              p,
              n,
              material.albedo,
              s.mode,
              candidate.u,
              candidate.v,
            );
          const target = Math.max(luminance(value), 0),
            choice = rng.next(),
            accepted =
              target > 0 &&
              choice * (reservoir.weightSum + target / candidate.pdf) <
                target / candidate.pdf;
          updateReservoir(
            reservoir,
            candidate.index,
            target,
            candidate.pdf,
            choice,
          );
          if (accepted) {
            reservoir.u = candidate.u;
            reservoir.v = candidate.v;
          }
        }
        if (bounce === 0 && sample > 0)
          for (
            let neighbor = 0;
            neighbor < s.restir.temporalNeighbors;
            neighbor++
          ) {
            const dx =
                neighbor === 0
                  ? 0
                  : (neighbor % 2 ? 1 : -1) * Math.ceil(neighbor / 2),
              x = (pixel % s.width) + dx;
            if (x < 0 || x >= s.width) continue;
            const prev = reservoirs[pixel + dx]!;
            if (
              !prev.count ||
              prev.selectedTarget <= 0 ||
              prev.age >= s.restir.maxTemporalAge ||
              prev.depth === undefined ||
              !prev.normal ||
              Math.abs(prev.depth - hit.t) >
                s.restir.depthThreshold * Math.max(hit.t, 1) ||
              dot(prev.normal, n) < s.restir.normalThreshold
            )
              continue;
            const target = Math.max(
              luminance(
                lightContribution(
                  scene,
                  prev.sample,
                  p,
                  n,
                  material.albedo,
                  s.mode,
                  prev.u ?? 0,
                  prev.v ?? 0,
                ),
              ),
              0,
            );
            mergeReservoir(
              reservoir,
              s.restir.biasCorrection
                ? prev
                : { ...prev, selectedTarget: target },
              target,
              rng.next(),
            );
          }
        if (bounce === 0 && sample > 0 && s.restir.spatialNeighbors) {
          for (
            let neighbor = 0;
            neighbor < s.restir.spatialNeighbors;
            neighbor++
          ) {
            const dx = Math.round(
                (rng.next() * 2 - 1) * s.restir.spatialRadius,
              ),
              dy = Math.round((rng.next() * 2 - 1) * s.restir.spatialRadius),
              x = (pixel % s.width) + dx,
              y = Math.floor(pixel / s.width) + dy;
            if (x < 0 || x >= s.width || y < 0 || y >= s.height) continue;
            const prev = reservoirs[y * s.width + x]!;
            if (
              !prev.normal ||
              prev.depth === undefined ||
              Math.abs(prev.depth - hit.t) >
                s.restir.depthThreshold * Math.max(hit.t, 1) ||
              dot(prev.normal, n) < s.restir.normalThreshold ||
              prev.age >= s.restir.maxTemporalAge
            )
              continue;
            const target = Math.max(
              luminance(
                lightContribution(
                  scene,
                  prev.sample,
                  p,
                  n,
                  material.albedo,
                  s.mode,
                  prev.u ?? 0,
                  prev.v ?? 0,
                ),
              ),
              0,
            );
            mergeReservoir(
              reservoir,
              s.restir.biasCorrection
                ? prev
                : { ...prev, selectedTarget: target },
              target,
              rng.next(),
            );
          }
        }
        if (bounce === 0) {
          reservoir.position = p;
          reservoir.normal = n;
          reservoir.depth = hit.t;
          primaryReservoir = reservoir;
        }
        const maxCount =
          s.restir.initialCandidates * (s.restir.maxTemporalAge + 1);
        if (reservoir.count > maxCount) {
          reservoir.weightSum *= maxCount / reservoir.count;
          reservoir.count = maxCount;
        }
        lightIndex = reservoir.sample;
        lightU = reservoir.u ?? 0;
        lightV = reservoir.v ?? 0;
        lighting = mul(
          lightContribution(
            scene,
            reservoir.sample,
            p,
            n,
            material.albedo,
            s.mode,
            lightU,
            lightV,
          ),
          reservoirWeight(reservoir),
        );
      } else {
        const candidate = choose();
        lightIndex = candidate.index;
        lightU = candidate.u;
        lightV = candidate.v;
        lighting = mul(
          lightContribution(
            scene,
            candidate.index,
            p,
            n,
            material.albedo,
            s.mode,
            candidate.u,
            candidate.v,
          ),
          1 / candidate.pdf,
        );
      }
    }
    if (scene.lights.length) {
      const light = sampleTraceLight(
        scene.lights[lightIndex]!,
        p,
        lightU,
        lightV,
      );
      if (
        scene.intersect(
          {
            origin: add(p, mul(n, 1e-4)),
            direction: light.direction,
            tMax: f(light.distance - 2e-4),
          },
          s.mode,
        )
      )
        lighting = [0, 0, 0];
    }
    const lit = had(throughput, lighting);
    beauty = add(beauty, lit);
    if (bounce === 0) direct = add(direct, lit);
    else indirect = add(indirect, lit);
    if (material.ior > 1) {
      direction = sampleDielectric(
        direction,
        n,
        hit.frontFace,
        material.ior,
        rng.next(),
      );
    } else if (rng.next() < material.metallic) {
      const sampled = sampleGgx(
        direction,
        n,
        material.albedo,
        material.roughness,
        rng.next(),
        rng.next(),
      );
      direction = sampled.direction;
      throughput = had(throughput, sampled.weight);
    } else {
      let u = rng.next(),
        v = rng.next(),
        weight = 1;
      if (s.guiding) {
        const pdf = s.guiding.pdf(pixel % s.width, Math.floor(pixel / s.width)),
          bins = pdf.length;
        let sum = 0,
          bin = 0;
        for (; bin < bins - 1; bin++) {
          sum += pdf[bin]!;
          if (v < sum) break;
        }
        const prev = sum - (bin < bins - 1 ? pdf[bin]! : 0);
        v = f((bin + clamp((v - prev) / pdf[bin]!)) / bins);
        weight = 1 / (bins * pdf[bin]!);
        if (bounce === 0) {
          guidingBin = bin;
          guidingWeight = Math.max(0, luminance(lit));
        }
      }
      direction = cosineDirection(u, v, n);
      throughput = mul(had(throughput, material.albedo), weight);
    }
    origin = add(p, mul(direction, 1e-4));
    if (bounce >= 2) {
      const survival = clamp(Math.max(...throughput), 0.05, 0.95);
      if (rng.next() > survival) break;
      throughput = mul(throughput, 1 / survival);
    }
  }
  const lum = luminance(beauty);
  if (s.clamp > 0 && lum > s.clamp) {
    const scale = f(s.clamp / lum);
    beauty = mul(beauty, scale);
    direct = mul(direct, scale);
    indirect = mul(indirect, scale);
    emission = mul(emission, scale);
  }
  record.set(beauty, 0);
  record[3] = 1;
  record.set(direct, 12);
  record.set(indirect, 16);
  record.set(emission, 20);
  record[27] = f(luminance(beauty) ** 2);
  return { record, reservoir: primaryReservoir, guidingBin, guidingWeight };
}
/** Average linear AOVs; nearest first-sample ID/depth remains stable for integer picking. */
export function decodeTraceRecords(
  data: Float32Array,
  width: number,
  height: number,
  samples: number,
): TraceResult {
  const out = emptyTraceResult(width, height, samples),
    bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  for (let i = 0; i < width * height; i++) {
    const base = i * 28;
    for (const [name, offset] of [
      ["color", 0],
      ["albedo", 4],
      ["normal", 8],
      ["direct", 12],
      ["indirect", 16],
      ["emission", 20],
      ["bentNormal", 24],
    ] as const)
      out[name].set(
        data.subarray(base + offset, base + offset + 3).map((v) => v / samples),
        i * 3,
      );
    out.id[i] = bits[base + 7]!;
    out.depth[i] = data[base + 11]!;
    out.visibility[i] = data[base + 15]! / samples;
    out.ao[i] = data[base + 19]! / samples;
    const color: TraceVec3 = [
      out.color[i * 3]!,
      out.color[i * 3 + 1]!,
      out.color[i * 3 + 2]!,
    ];
    out.variance[i] = Math.max(
      0,
      data[base + 27]! / samples - luminance(color) ** 2,
    );
    const n = unit([
        out.normal[i * 3]!,
        out.normal[i * 3 + 1]!,
        out.normal[i * 3 + 2]!,
      ]),
      b = unit([
        out.bentNormal[i * 3]!,
        out.bentNormal[i * 3 + 1]!,
        out.bentNormal[i * 3 + 2]!,
      ]);
    out.normal.set(n, i * 3);
    out.bentNormal.set(b, i * 3);
  }
  return out;
}
export function accumulateRecord(
  sum: Float32Array,
  record: Float32Array,
  pixel: number,
  sample: number,
): void {
  const off = pixel * 28;
  const ids = new Uint32Array(sum.buffer),
    inputIds = new Uint32Array(record.buffer);
  for (let i = 0; i < 28; i++) {
    if (i === 7) {
      if (sample === 0) ids[off + i] = inputIds[i]!;
    } else if (i === 11) {
      if (sample === 0) sum[off + i] = record[i]!;
    } else sum[off + i] = f(sum[off + i]! + record[i]!);
  }
}
