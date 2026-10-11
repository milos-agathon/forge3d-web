import type { TraceVec3 } from "./trace-types.js";
import { add, sub, mul, had, dot, unit, f, clamp } from "./trace-math.js";
import { localToWorld } from "./trace-sampling.js";

export const reflectDirection = (
  incident: TraceVec3,
  normal: TraceVec3,
): TraceVec3 => unit(sub(incident, mul(normal, f(2 * dot(incident, normal)))));
export function smithG1(cosine: number, alpha: number): number {
  if (cosine <= 0) return 0;
  return f(
    (2 * cosine) /
      (cosine +
        Math.sqrt(alpha * alpha + (1 - alpha * alpha) * cosine * cosine)),
  );
}
/** GGX half-vector importance sampling with the matching BRDF/PDF weight. */
export function sampleGgx(
  incident: TraceVec3,
  normal: TraceVec3,
  f0: TraceVec3,
  roughness: number,
  u: number,
  v: number,
): { direction: TraceVec3; weight: TraceVec3 } {
  const alpha = Math.max(0.001, roughness * roughness),
    a2 = alpha * alpha,
    z = Math.sqrt((1 - u) / (1 + (a2 - 1) * u)),
    r = Math.sqrt(Math.max(0, 1 - z * z)),
    phi = 2 * Math.PI * v;
  const h = localToWorld(
      [f(r * Math.cos(phi)), f(r * Math.sin(phi)), f(z)],
      normal,
    ),
    direction = reflectDirection(incident, h);
  const ni = Math.max(0, -dot(incident, normal)),
    no = Math.max(0, dot(direction, normal)),
    nh = Math.max(0, dot(normal, h)),
    vh = Math.max(0, -dot(incident, h));
  if (!ni || !no || !nh || !vh) return { direction, weight: [0, 0, 0] };
  const fresnel = f0.map((c) =>
    f(c + (1 - c) * (1 - vh) ** 5),
  ) as unknown as TraceVec3;
  const scale = f((smithG1(ni, alpha) * smithG1(no, alpha) * vh) / (ni * nh));
  return { direction, weight: mul(fresnel, scale) };
}
/** Schlick dielectric sampling; the face flag distinguishes entry from exit. */
export function sampleDielectric(
  incident: TraceVec3,
  normal: TraceVec3,
  frontFace: boolean,
  ior: number,
  u: number,
): TraceVec3 {
  const eta = frontFace ? 1 / ior : ior,
    cos = clamp(-dot(incident, normal)),
    sin2 = eta * eta * (1 - cos * cos),
    f0 = ((1 - ior) / (1 + ior)) ** 2;
  if (sin2 >= 1 || u < f0 + (1 - f0) * (1 - cos) ** 5)
    return reflectDirection(incident, normal);
  return unit(
    add(mul(incident, eta), mul(normal, eta * cos - Math.sqrt(1 - sin2))),
  );
}
/** Free-flight importance ratio for a scalar majorant and RGB extinction. */
export function mediumRatio(
  sigma: TraceVec3,
  majorant: number,
  distance: number,
): TraceVec3 {
  return sigma.map((s) =>
    f(Math.exp((majorant - s) * distance)),
  ) as unknown as TraceVec3;
}
