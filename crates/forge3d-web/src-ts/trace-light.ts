import type { TraceLight, TraceVec3 } from "./trace-types.js";
import { add, sub, mul, unit, dot, cross, length, f } from "./trace-math.js";
export function sampleTraceLight(
  light: Required<TraceLight>,
  point: TraceVec3,
  u = 0,
  v = 0,
): { direction: TraceVec3; distance: number; radiance: TraceVec3 } {
  if (light.type === "directional")
    return {
      direction: mul(light.direction, -1),
      distance: 1e30,
      radiance: mul(light.color, light.intensity),
    };
  let position = light.position;
  if (light.type === "disc") {
    const n = light.normal,
      t = unit(cross(Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0], n)),
      b = cross(n, t),
      r = f(Math.sqrt(u) * light.radius),
      phi = 2 * Math.PI * v;
    position = add(
      position,
      add(mul(t, f(r * Math.cos(phi))), mul(b, f(r * Math.sin(phi)))),
    );
  }
  const delta = sub(position, point),
    distance = length(delta),
    direction = unit(delta);
  let scale = light.intensity / Math.max(distance * distance, 1e-20);
  if (light.type === "disc")
    scale *=
      Math.max(0, -dot(light.normal, direction)) *
      Math.PI *
      light.radius *
      light.radius;
  return { direction, distance, radiance: mul(light.color, f(scale)) };
}
