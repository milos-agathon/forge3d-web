import { TRACE_RECORD } from './trace-packets.js';
import type {
  TraceCamera,
  TraceVec3,
  TraceResult,
  TraceTraversalMode,
} from "./trace-types.js";
import { TraceScene, type EffectiveTraceMaterial } from "./trace-scene.js";
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
  cosineDirection,
  hgPhase,
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
import {
  traceBrdf,
  sampleGgx,
  sampleDielectric,
  mediumRatio,
} from "./trace-bsdf.js";
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
function lightContribution(
  scene: TraceScene,
  index: number,
  p: TraceVec3,
  n: TraceVec3,
  material: EffectiveTraceMaterial,
  view: TraceVec3,
  u = 0,
  v = 0,
): TraceVec3 {
  const l = sampleTraceLight(scene.lights[index]!, p, u, v),
    cos = Math.max(0, dot(n, l.direction));
  if (!cos || l.distance < 1e-4) return [0, 0, 0];
  return mul(
    had(traceBrdf(material, n, view, l.direction), l.radiance),
    f(cos),
  );
}
function chooseLight(scene: TraceScene, rng: TraceRng) {
  const u = rng.next(),
    v = rng.next(),
    total = scene.lights.reduce((sum, l) => sum + l.weight, 0);
  let remaining = u * total;
  for (let i = 0; i < scene.lights.length; i++) {
    const light = scene.lights[i]!;
    remaining -= light.weight;
    if (remaining < 0 || i + 1 === scene.lights.length)
      return {
        index: i,
        pdf: light.weight / total,
        u: clamp((remaining + light.weight) / light.weight),
        v,
      };
  }
  return { index: 0, pdf: 1, u: 0, v };
}
/** Analytic Beer transmittance on a finite or directional-light shadow segment. */
export function mediumTransmittance(
  scene: TraceScene,
  origin: TraceVec3,
  direction: TraceVec3,
  distance: number,
): TraceVec3 {
  const m = scene.medium;
  if (!m) return [1, 1, 1];
  const interval = boundsInterval(m.bounds, {
    origin,
    direction,
    tMin: 0,
    tMax: distance,
  });
  if (!interval) return [1, 1, 1];
  const sigma = add(m.sigmaA, m.sigmaS),
    span = f(interval[1] - interval[0]);
  return sigma.map((s) => f(Math.exp(-s * span))) as unknown as TraceVec3;
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
    record = new Float32Array(TRACE_RECORD.words),
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
  let primaryEmission = 0;
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
          if (scene.lights.length) {
            const choice = chooseLight(scene, rng),
              light = sampleTraceLight(
                scene.lights[choice.index]!,
                origin,
                choice.u,
                choice.v,
              ),
              phase = hgPhase(
                clamp(dot(direction, light.direction), -1, 1),
                m.g ?? 0,
              );
            if (
              light.distance >= 1e-4 &&
              !scene.intersect(
                {
                  origin: add(origin, mul(light.direction, 1e-4)),
                  direction: light.direction,
                  tMax: f(light.distance - 2e-4),
                },
                s.mode,
              )
            ) {
              const lit = had(
                throughput,
                had(
                  mul(light.radiance, f(phase / choice.pdf)),
                  mediumTransmittance(
                    scene,
                    origin,
                    light.direction,
                    light.distance,
                  ),
                ),
              );
              beauty = add(beauty, lit);
              if (bounce === 0) direct = add(direct, lit);
              else indirect = add(indirect, lit);
            }
          }
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
      record.set(material.albedo, TRACE_RECORD.albedo);
      bits[TRACE_RECORD.id] = hit.id;
      record.set(n, TRACE_RECORD.normal);
      record[TRACE_RECORD.depth] = hit.t;
      record[TRACE_RECORD.visibility] = 1;
      const aoDir = cosineDirection(rng.next(), rng.next(), n),
        occluded = scene.intersect(
          { origin: add(p, mul(n, 1e-4)), direction: aoDir, tMax: 1 },
          s.mode,
        );
      record[TRACE_RECORD.ao] = occluded ? 0 : 1;
      record.set(occluded ? [0, 0, 0] : aoDir, TRACE_RECORD.bentNormal);
    }
    let lighting: TraceVec3 = [0, 0, 0],
      lightIndex = 0,
      lightU = 0,
      lightV = 0;
    if (scene.lights.length) {
      reservoir = emptyReservoir();
      const choose = () => chooseLight(scene, rng);
      if (s.restir) {
        for (let i = 0; i < s.restir.initialCandidates; i++) {
          const candidate = choose(),
            value = lightContribution(
              scene,
              candidate.index,
              p,
              n,
              material,
              mul(direction, -1),
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
                  material,
                  mul(direction, -1),
                  prev.u ?? 0,
                  prev.v ?? 0,
                ),
              ),
              0,
            );
            mergeReservoir(
              reservoir,
              prev,
              target,
              rng.next(),
              s.restir.biasCorrection,
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
              !prev.count ||
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
                  material,
                  mul(direction, -1),
                  prev.u ?? 0,
                  prev.v ?? 0,
                ),
              ),
              0,
            );
            mergeReservoir(
              reservoir,
              prev,
              target,
              rng.next(),
              s.restir.biasCorrection,
            );
          }
        }
        if (bounce === 0) {
          // Expire the whole proposal history on a deterministic epoch, rather
          // than conditioning admission on the age of a randomly selected light.
          reservoir.age = sample % (s.restir.maxTemporalAge + 1);
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
            material,
            mul(direction, -1),
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
            material,
            mul(direction, -1),
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
      lighting = had(
        lighting,
        mediumTransmittance(scene, p, light.direction, light.distance),
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
        material.ax,
        material.ay,
      );
      direction = sampled.direction;
      throughput = had(throughput, sampled.weight);
    } else {
      let u = rng.next(),
        v = rng.next(),
        weight = 1;
      if (s.guiding) {
        const sampled = s.guiding.sample(
          pixel % s.width,
          Math.floor(pixel / s.width),
          v,
        );
        v = sampled.v;
        weight = sampled.weight;
        if (bounce === 0) {
          guidingBin = sampled.bin;
          primaryEmission = luminance(emission);
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
  // Credit only radiance returned after the guided bounce. Its inverse-PDF
  // weight estimates the bin integral independently of selection frequency.
  if (guidingBin !== undefined)
    guidingWeight = Math.max(
      0,
      f(luminance(add(indirect, emission)) - primaryEmission),
    );
  const lum = luminance(beauty);
  if (s.clamp > 0 && lum > s.clamp) {
    const scale = f(s.clamp / lum);
    beauty = mul(beauty, scale);
    direct = mul(direct, scale);
    indirect = mul(indirect, scale);
    emission = mul(emission, scale);
  }
  record.set(beauty, TRACE_RECORD.color);
  record[TRACE_RECORD.training] = guidingWeight ?? 0;
  bits[TRACE_RECORD.guidingBin] = guidingBin ?? 0xffffffff;
  record.set(direct, TRACE_RECORD.direct);
  record.set(indirect, TRACE_RECORD.indirect);
  record.set(emission, TRACE_RECORD.emission);
  record[TRACE_RECORD.variance] = f(luminance(beauty) ** 2);
  return { record, reservoir: primaryReservoir, guidingBin, guidingWeight };
}
export { emptyTraceResult, decodeTraceRecords, accumulateRecord } from './trace-packets.js';
