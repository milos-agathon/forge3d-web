import type { ShapedText } from "./label-types.js";
// Scan-convert flattened outlines to non-overlapping trapezoids. Each slab is
// bounded by contour vertices, so holes retain the font's nonzero winding rule.
export function glyphOutlineMesh(
  commands: readonly { type: string; values: number[] }[],
  tolerance = 0.15,
): number[] {
  type P = [number, number];
  const contours: P[][] = [];
  let current: P[] = [],
    p: P = [0, 0];
  const distance = (q: P, a: P, b: P) =>
    Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) /
    Math.max(1e-12, Math.hypot(b[0] - a[0], b[1] - a[1]));
  const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const quad = (a: P, b: P, c: P, depth = 0): void => {
    if (depth >= 12 || distance(b, a, c) <= tolerance) {
      current.push(c);
      return;
    }
    const ab = mid(a, b),
      bc = mid(b, c),
      center = mid(ab, bc);
    quad(a, ab, center, depth + 1);
    quad(center, bc, c, depth + 1);
  };
  const cubic = (a: P, b: P, c: P, d: P, depth = 0): void => {
    if (
      depth >= 12 ||
      Math.max(distance(b, a, d), distance(c, a, d)) <= tolerance
    ) {
      current.push(d);
      return;
    }
    const ab = mid(a, b),
      bc = mid(b, c),
      cd = mid(c, d),
      abc = mid(ab, bc),
      bcd = mid(bc, cd),
      center = mid(abc, bcd);
    cubic(a, ab, abc, center, depth + 1);
    cubic(center, bcd, cd, d, depth + 1);
  };
  for (const cmd of commands) {
    const v = cmd.values;
    switch (cmd.type.toUpperCase()) {
      case "M":
        if (current.length) contours.push(current);
        p = [v[0]!, v[1]!];
        current = [p];
        break;
      case "L":
        p = [v[0]!, v[1]!];
        current.push(p);
        break;
      case "Q": {
        const end: P = [v[2]!, v[3]!];
        quad(p, [v[0]!, v[1]!], end);
        p = end;
        break;
      }
      case "C": {
        const end: P = [v[4]!, v[5]!];
        cubic(p, [v[0]!, v[1]!], [v[2]!, v[3]!], end);
        p = end;
        break;
      }
      case "Z":
        if (current.length) contours.push(current);
        current = [];
        break;
      default:
        throw Error(`Unsupported glyph path command: ${cmd.type}`);
    }
  }
  if (current.length) contours.push(current);
  const edges: { a: P; b: P; sign: number }[] = [];
  for (const ring of contours)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      if (a[1] !== b[1]) edges.push({ a, b, sign: b[1] > a[1] ? 1 : -1 });
    }
  const ys = [...new Set(edges.flatMap((e) => [e.a[1], e.b[1]]))].sort(
      (a, b) => a - b,
    ),
    mesh: number[] = [];
  const at = (e: (typeof edges)[number], y: number) =>
    e.a[0] + ((e.b[0] - e.a[0]) * (y - e.a[1])) / (e.b[1] - e.a[1]);
  for (let i = 1; i < ys.length; i++) {
    const lo = ys[i - 1]!,
      hi = ys[i]!,
      center = (lo + hi) / 2,
      active = edges
        .filter(
          (e) =>
            center > Math.min(e.a[1], e.b[1]) &&
            center < Math.max(e.a[1], e.b[1]),
        )
        .sort((a, b) => at(a, center) - at(b, center));
    let winding = 0,
      left: (typeof edges)[number] | undefined;
    for (const edge of active) {
      const before = winding;
      winding += edge.sign;
      if (before === 0 && winding !== 0) left = edge;
      else if (before !== 0 && winding === 0 && left) {
        const a = at(left, lo),
          b = at(edge, lo),
          c = at(edge, hi),
          d = at(left, hi);
        mesh.push(a, lo, 0, b, lo, 0, c, hi, 0, a, lo, 0, c, hi, 0, d, hi, 0);
        left = undefined;
      }
    }
  }
  return mesh;
}
export function shapedTextMesh(shaped: ShapedText): Float32Array {
  const result: number[] = [];
  for (const glyph of shaped.glyphs) {
    const mesh = glyphOutlineMesh(glyph.path);
    for (let i = 0; i < mesh.length; i += 3)
      result.push(mesh[i]! + glyph.x, mesh[i + 1]! - glyph.y, 0);
    if (result.length > 9_000_000)
      throw Error("Label mesh exceeds one million triangles");
  }
  return new Float32Array(result);
}
export function labelStrokeMesh(
  points: readonly [number, number][],
  width: number,
  closed = false,
): Float32Array {
  const mesh: number[] = [];
  for (let i = 1; i < points.length + (closed ? 1 : 0); i++) {
    const a = points[i - 1]!,
      b = points[i % points.length]!,
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    if (!length) continue;
    const ox = ((-dy / length) * width) / 2,
      oy = ((dx / length) * width) / 2;
    mesh.push(
      a[0] + ox,
      a[1] + oy,
      0,
      b[0] + ox,
      b[1] + oy,
      0,
      b[0] - ox,
      b[1] - oy,
      0,
      a[0] + ox,
      a[1] + oy,
      0,
      b[0] - ox,
      b[1] - oy,
      0,
      a[0] - ox,
      a[1] - oy,
      0,
    );
  }
  return new Float32Array(mesh);
}
