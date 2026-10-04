import type {
  LabelCandidate,
  LabelPoint,
  LabelRecord,
  LabelRect,
} from "./label-types.js";
export function labelCoordinates(value: unknown): LabelPoint | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const v = [Number(value[0]), Number(value[1]), Number(value[2] ?? 0)];
  return v.every(Number.isFinite) ? (v as LabelPoint) : undefined;
}
export function labelRect(value: readonly number[]): LabelRect {
  return [
    Math.min(value[0]!, value[2]!),
    Math.min(value[1]!, value[3]!),
    Math.max(value[0]!, value[2]!),
    Math.max(value[1]!, value[3]!),
  ];
}
export function labelRectsIntersect(
  a: readonly number[],
  b: readonly number[],
): boolean {
  const x = labelRect(a),
    y = labelRect(b);
  return x[0] <= y[2] && x[2] >= y[0] && x[1] <= y[3] && x[3] >= y[1];
}
// Native LabelPlan radial jitter uses the first 64 SHA-256 bits of seed|id|index|radial.
export function labelSeedUnit(key: string): number {
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++)
    if (!primes.some((p) => p * p <= n && n % p === 0)) primes.push(n);
  const frac = (x: number) => ((x - Math.floor(x)) * 4294967296) >>> 0;
  const k = primes.map((p) => frac(Math.cbrt(p))),
    h = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)));
  const input = new TextEncoder().encode(key),
    length = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(input);
  bytes[input.length] = 128;
  const dv = new DataView(bytes.buffer);
  dv.setUint32(length - 4, input.length * 8);
  const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!,
        b = w[i - 2]!;
      w[i] =
        (w[i - 16]! +
          (rr(a, 7) ^ rr(a, 18) ^ (a >>> 3)) +
          w[i - 7]! +
          (rr(b, 17) ^ rr(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, j] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
          (j +
            (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i]! +
            w[i]!) >>>
          0,
        t2 =
          ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) >>>
          0;
      j = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, j].forEach((v, i) => {
      h[i] = (h[i]! + v) >>> 0;
    });
  }
  return (h[0]! * 4294967296 + h[1]!) / 18446744073709551616;
}
export function makeLabelCandidate(
  id: string,
  type: string,
  anchor: LabelPoint,
  score: number,
  key: string,
  sample: Record<string, unknown>,
  details: Record<string, unknown> = {},
): LabelCandidate {
  return {
    candidate_id: id,
    candidate_type: type,
    anchor,
    score,
    bounds: [anchor[0], anchor[1], anchor[0], anchor[1]],
    terrain_sample: sample,
    details,
    ordering_key: key,
  };
}
export function pointLabelCandidates(
  id: string,
  p: LabelPoint,
  score: number,
  key: string,
  r: LabelRecord,
  seed: number,
  sample: Record<string, unknown>,
): LabelCandidate[] {
  const policy = r.candidate_policy ?? {},
    offset = Number(policy.offset_px ?? r.candidate_offset_px ?? 12),
    radius = Number(
      policy.radial_radius_px ?? r.radial_radius_px ?? offset * 1.5,
    );
  const count = Math.max(
      0,
      Math.trunc(Number(policy.radial_count ?? r.radial_count ?? 4)),
    ),
    jitter = Math.max(
      0,
      Number(policy.radial_jitter_deg ?? r.radial_jitter_deg ?? 0),
    );
  if (![offset, radius, count, jitter].every(Number.isFinite) || count > 256)
    throw Error("Invalid label candidate policy");
  const anchors: LabelPoint[] = [
    p,
    [p[0], p[1] - offset, p[2]],
    [p[0], p[1] + offset, p[2]],
    [p[0] - offset, p[1], p[2]],
    [p[0] + offset, p[1], p[2]],
  ];
  const names = ["center", "above", "below", "left", "right"];
  const result = anchors.map((a, i) =>
    makeLabelCandidate(
      `${id}:${names[i]}`,
      names[i]!,
      a,
      score - i * 0.001,
      `${key}:${String(i).padStart(2, "0")}:${names[i]}`,
      sample,
      i ? { offset_px: offset } : {},
    ),
  );
  for (let i = 0; i < count; i++) {
    const j = (labelSeedUnit(`${seed}|${id}|${i}|radial`) - 0.5) * 2 * jitter,
      angle = ((((360 / count) * i + j) % 360) + 360) % 360,
      rad = (angle * Math.PI) / 180;
    result.push(
      makeLabelCandidate(
        `${id}:radial-${i}`,
        "radial",
        [p[0] + Math.cos(rad) * radius, p[1] + Math.sin(rad) * radius, p[2]],
        score - (5 + i) * 0.001,
        `${key}:${String(5 + i).padStart(2, "0")}:radial-${i}`,
        sample,
        {
          angle_deg: Math.round(angle * 1e6) / 1e6,
          jitter_deg: Math.round(j * 1e6) / 1e6 || 0,
          radial_index: i,
          radius_px: radius,
        },
      ),
    );
  }
  if (
    r.leader_line ||
    ["callout", "leader"].includes(String(r.placement_preset).toLowerCase())
  )
    result.unshift(
      makeLabelCandidate(
        `${id}:leader`,
        "leader_line",
        [p[0] + offset, p[1] - offset, p[2]],
        score + 0.01,
        `${key}:00:leader`,
        sample,
        {
          leader_line: true,
          placement_preset: r.placement_preset ?? "callout",
          anchor: p,
          offset_px: offset,
        },
      ),
    );
  return result;
}
export function labelLinePoints(value: unknown): LabelPoint[] | undefined {
  if (!Array.isArray(value)) return;
  const points = value.map(labelCoordinates);
  return points.length >= 2 && points.every((p) => p !== undefined)
    ? (points as LabelPoint[])
    : undefined;
}
export function labelLineLength(points: readonly LabelPoint[]): number {
  return points
    .slice(1)
    .reduce(
      (s, p, i) => s + Math.hypot(...p.map((v, j) => v - points[i]![j]!)),
      0,
    );
}
export function interpolateLabelLine(
  points: readonly LabelPoint[],
  distance: number,
): { point: LabelPoint; angle: number } {
  let remaining = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      d = b.map((v, j) => v - a[j]!),
      length = Math.hypot(...d);
    if (!length) continue;
    if (remaining <= length)
      return {
        point: a.map((v, j) => v + (d[j]! * remaining) / length) as LabelPoint,
        angle: Math.atan2(d[1]!, d[0]!),
      };
    remaining -= length;
  }
  const a = points[points.length - 2]!,
    b = points.at(-1)!;
  return { point: [...b], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
export function lineLabelCandidates(
  id: string,
  points: LabelPoint[],
  score: number,
  key: string,
  r: LabelRecord,
  sample: Record<string, unknown>,
): LabelCandidate[] {
  const length = labelLineLength(points),
    repeat = Math.max(0, r.repeat_distance ?? 0);
  if (!(length > 0) || !Number.isFinite(repeat)) return [];
  const count = repeat > 0 ? Math.floor(length / repeat) + 1 : 1;
  if (count > 10000) throw Error("Label repeat count exceeds 10000");
  return Array.from({ length: count }, (_, i) => {
    const distance = repeat ? i * repeat : length * 0.5;
    return makeLabelCandidate(
      `${id}:repeat-${i}`,
      "line_repeat",
      interpolateLabelLine(points, distance).point,
      score - i * 0.001,
      `${key}:${String(i).padStart(2, "0")}:line-repeat`,
      sample,
      {
        repeat_distance: repeat,
        distance_along: Math.round(distance * 1e6) / 1e6,
        line_length: Math.round(length * 1e6) / 1e6,
        placement_preset: r.placement_preset ?? "line",
      },
    );
  });
}
export function polygonLabelCandidates(
  id: string,
  value: unknown,
  score: number,
  key: string,
  sample: Record<string, unknown>,
): { selected: LabelCandidate; candidates: LabelCandidate[] } | undefined {
  if (!Array.isArray(value)) return;
  const ring = labelLinePoints(value[0]);
  if (!ring || ring.length < 4) return;
  if (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1])
    ring.push([...ring[0]!]);
  if (new Set(ring.slice(0, -1).map((p) => `${p[0]},${p[1]}`)).size < 3) return;
  let area = 0,
    cx = 0,
    cy = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!,
      b = ring[i]!,
      c = a[0] * b[1] - b[0] * a[1];
    area += c;
    cx += (a[0] + b[0]) * c;
    cy += (a[1] + b[1]) * c;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) return;
  const centroid: LabelPoint = [cx / (6 * area), cy / (6 * area), 0];
  const inside = (x: number, y: number) => {
    let hit = false;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1]!,
        b = ring[i]!;
      if (
        a[1] > y !== b[1] > y &&
        x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
      )
        hit = !hit;
    }
    return hit;
  };
  const xs = ring.map((p) => p[0]),
    ys = ring.map((p) => p[1]),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  let visual = centroid,
    best = -Infinity;
  for (let ix = 0; ix < 12; ix++)
    for (let iy = 0; iy < 12; iy++) {
      const x = minX + ((ix + 0.5) * (maxX - minX)) / 12,
        y = minY + ((iy + 0.5) * (maxY - minY)) / 12;
      if (!inside(x, y)) continue;
      const distance = Math.min(
        ...ring.slice(0, -1).map((p) => (x - p[0]) ** 2 + (y - p[1]) ** 2),
      );
      if (
        distance > best ||
        (distance === best &&
          (x > visual[0] || (x === visual[0] && y > visual[1])))
      ) {
        best = distance;
        visual = [x, y, 0];
      }
    }
  const contained = inside(centroid[0], centroid[1]),
    a = makeLabelCandidate(
      `${id}:centroid`,
      "centroid",
      centroid,
      score,
      `${key}:00:centroid`,
      sample,
      { area: Math.abs(area), inside_polygon: contained },
    ),
    b = makeLabelCandidate(
      `${id}:visual-center`,
      "visual_center",
      visual,
      score - 0.001,
      `${key}:01:visual-center`,
      sample,
      { area: Math.abs(area), fallback_for: "centroid" },
    );
  return { selected: contained ? a : b, candidates: [a, b] };
}
