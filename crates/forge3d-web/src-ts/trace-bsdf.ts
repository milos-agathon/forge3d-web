import type { TraceVec3 } from "./trace-types.js";
import { add, sub, mul, dot, cross, unit, f, clamp } from "./trace-math.js";
import type { EffectiveTraceMaterial } from "./trace-scene.js";
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
function tangentBasis(n: TraceVec3): [TraceVec3, TraceVec3] {
  const t = unit(cross(Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0], n));
  return [t, cross(n, t)];
}
function smithAniso(
  v: TraceVec3,
  n: TraceVec3,
  ax: number,
  ay: number,
): number {
  const c = Math.max(0, dot(v, n));
  if (!c) return 0;
  const [t, b] = tangentBasis(n),
    x = ax * dot(v, t),
    y = ay * dot(v, b);
  return f((2 * c) / (c + Math.sqrt(c * c + x * x + y * y)));
}
/** The same Lambert/GGX mixture used by scatter, evaluated for direct lights. */
export function traceBrdf(
  m: EffectiveTraceMaterial,
  n: TraceVec3,
  view: TraceVec3,
  light: TraceVec3,
): TraceVec3 {
  const nv = Math.max(0, dot(n, view)),
    nl = Math.max(0, dot(n, light));
  if (!nv || !nl || m.ior > 1) return [0, 0, 0];
  const diffuse = mul(m.albedo, f((1 - m.metallic) / Math.PI));
  if (!m.metallic) return diffuse;
  const h = unit(add(view, light)),
    nh = Math.max(0, dot(n, h)),
    vh = Math.max(0, dot(view, h)),
    a = Math.max(0.001, m.roughness * m.roughness);
  let D: number, G: number;
  if (Math.abs(m.ax - m.ay) < 1e-4) {
    const d = nh * nh * (a * a - 1) + 1;
    D = (a * a) / (Math.PI * d * d);
    G = smithG1(nv, a) * smithG1(nl, a);
  } else {
    const [t, b] = tangentBasis(n),
      x = dot(h, t) / m.ax,
      y = dot(h, b) / m.ay,
      d = x * x + y * y + nh * nh;
    D = 1 / (Math.PI * m.ax * m.ay * d * d);
    G = smithAniso(view, n, m.ax, m.ay) * smithAniso(light, n, m.ax, m.ay);
  }
  const scale = (m.metallic * D * G) / (4 * nv * nl);
  return add(
    diffuse,
    m.albedo.map((c) =>
      f((c + (1 - c) * (1 - vh) ** 5) * scale),
    ) as unknown as TraceVec3,
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
  ax = Math.max(0.001, roughness * roughness),
  ay = Math.max(0.001, roughness * roughness),
): { direction: TraceVec3; weight: TraceVec3 } {
  const alpha = Math.max(0.001, roughness * roughness),
    a2 = alpha * alpha,
    z = Math.sqrt((1 - u) / (1 + (a2 - 1) * u)),
    r = Math.sqrt(Math.max(0, 1 - z * z)),
    phi = 2 * Math.PI * v;
  const aniso = Math.abs(ax - ay) >= 1e-4;
  const h = localToWorld(
      aniso
        ? [
            f(ax * Math.sqrt(u) * Math.cos(phi)),
            f(ay * Math.sqrt(u) * Math.sin(phi)),
            f(Math.sqrt(1 - u)),
          ]
        : [f(r * Math.cos(phi)), f(r * Math.sin(phi)), f(z)],
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
  const gi = aniso
      ? smithAniso(mul(incident, -1), normal, ax, ay)
      : smithG1(ni, alpha),
    go = aniso ? smithAniso(direction, normal, ax, ay) : smithG1(no, alpha);
  const scale = f((gi * go * vh) / (ni * nh));
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
