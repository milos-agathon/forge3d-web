import {vectorInvalid} from "./vector-layers.js";
import type {VectorPosition as P} from "./vector-types.js";
const cross = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
function inside(p: P, a: P, b: P, c: P): boolean { return cross(a, b, p) >= -1e-10 && cross(b, c, p) >= -1e-10 && cross(c, a, p) >= -1e-10; }
function area(r: P[]): number { return r.reduce((sum, p, i) => { const q = r[(i + 1) % r.length]!; return sum + p[0] * q[2] - q[0] * p[2]; }, 0) / 2; }
function inRing(p: P, r: P[]): boolean { let hit = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!, b = r[j]!;
    if ((a[2] > p[2]) !== (b[2] > p[2]) && p[0] < (b[0] - a[0]) * (p[2] - a[2]) / (b[2] - a[2]) + a[0])
        hit = !hit;
} return hit; }
function same(a: P, b: P): boolean { return a[0] === b[0] && a[2] === b[2]; }
function intersects(a: P, b: P, c: P, d: P): boolean { return cross(a, b, c) * cross(a, b, d) < -1e-12 && cross(c, d, a) * cross(c, d, b) < -1e-12; }
/** Ear clipping with visible bridges for holes. Invalid/self-intersecting rings fail. */
export function triangulateVectorPolygon(input: P[][]): P[][] {
    const rings = input.map(r => { const out = r.map(p => [...p] as P); if (out.length > 3 && same(out[0]!, out.at(-1)!))
        out.pop(); if (Math.abs(area(out)) < 1e-12)
        throw vectorInvalid("degenerate polygon ring"); return out; });
    let outer = rings[0]!;
    if (area(outer) < 0)
        outer.reverse();
    for (const hole of rings.slice(1)) {
        if (area(hole) > 0)
            hole.reverse();
        let hi = 0;
        for (let i = 1; i < hole.length; i++)
            if (hole[i]![0] > hole[hi]![0])
                hi = i;
        const h = hole[hi]!;
        let best = -1, bestDistance = Infinity;
        for (let i = 0; i < outer.length; i++) {
            const v = outer[i]!, mid: P = [(v[0] + h[0]) / 2, 0, (v[2] + h[2]) / 2];
            if (!inRing(mid, outer) || rings.slice(1).some(r => inRing(mid, r)))
                continue;
            if ([outer, ...rings.slice(1)].some(r => r.some((a, k) => { const b = r[(k + 1) % r.length]!; return !same(a, h) && !same(b, h) && !same(a, v) && !same(b, v) && intersects(h, v, a, b); })))
                continue;
            const d = (v[0] - h[0]) ** 2 + (v[2] - h[2]) ** 2;
            if (d < bestDistance) {
                best = i;
                bestDistance = d;
            }
        }
        if (best < 0)
            throw vectorInvalid("polygon hole has no visible bridge");
        const ordered = [...hole.slice(hi), ...hole.slice(0, hi)];
        outer = [...outer.slice(0, best + 1), ...ordered, h, outer[best]!, ...outer.slice(best + 1)];
    }
    const triangles: P[][] = [], points = [...outer];
    while (points.length > 3) {
        let clipped = false;
        for (let i = 0; i < points.length; i++) {
            const a = points[(i + points.length - 1) % points.length]!, b = points[i]!, c = points[(i + 1) % points.length]!;
            if (cross(a, b, c) <= 1e-12)
                continue;
            if (points.some((p, k) => k !== i && k !== (i + points.length - 1) % points.length && k !== (i + 1) % points.length && !same(p, a) && !same(p, b) && !same(p, c) && inside(p, a, b, c)))
                continue;
            triangles.push([a, b, c]);
            points.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped)
            throw vectorInvalid("polygon is self-intersecting or degenerate");
    }
    if (points.length === 3 && Math.abs(cross(points[0]!, points[1]!, points[2]!)) > 1e-12)
        triangles.push(points);
    return triangles;
}
