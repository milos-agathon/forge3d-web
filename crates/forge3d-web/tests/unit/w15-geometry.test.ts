import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { crossCheckNativeHistory } from "./w15-native-history.js";
import * as f from "../../src-ts/index.js";
import type { MeshBuffers } from "../../src-ts/index.js";
const golden = JSON.parse(
  readFileSync(
    new URL("../fixtures/w15/mesh-io-v1.json", import.meta.url),
    "utf8",
  ),
);
const path: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
  plane = () => f.generatePrimitive("plane", { resolution: [2, 2] });
function maximum(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
function compare(m: MeshBuffers, ref: any, reordered = false) {
  if (!reordered) {
    expect([...m.indices]).toEqual(ref.indices);
    for (const key of ["positions", "normals", "uvs"] as const)
      expect(maximum(m[key], ref[key])).toBeLessThanOrEqual(1e-5);
    return;
  }
  expect(m.positions.length).toBe(ref.positions.length);
  expect(m.indices.length).toBe(ref.indices.length);
  const remap: number[] = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    let best = Infinity,
      id = -1;
    for (let j = 0; j < ref.positions.length; j += 3) {
      const distance = Math.max(
        ...[0, 1, 2].map((a) =>
          Math.abs(m.positions[i + a]! - ref.positions[j + a]),
        ),
      );
      if (distance < best) {
        best = distance;
        id = j / 3;
      }
    }
    expect(best).toBeLessThanOrEqual(1e-5);
    remap.push(id);
    for (let a = 0; a < 3; a++)
      expect(
        Math.abs(m.normals[i + a]! - ref.normals[id * 3 + a]),
      ).toBeLessThanOrEqual(1e-5);
    if (m.uvs.length)
      for (let a = 0; a < 2; a++)
        expect(
          Math.abs(m.uvs[(i / 3) * 2 + a]! - ref.uvs[id * 2 + a]),
        ).toBeLessThanOrEqual(1e-5);
  }
  const triangles = (indices: number[]) =>
    Array.from({ length: indices.length / 3 }, (_, i) => {
      const t = indices.slice(i * 3, i * 3 + 3),
        start = t.indexOf(Math.min(...t));
      return [...t.slice(start), ...t.slice(0, start)].join(",");
    }).sort();
  expect(triangles([...m.indices].map((i) => remap[i]!))).toEqual(
    triangles(ref.indices),
  );
}
describe("W15 independently executed native geometry", () => {
  it("pins compiled source hashes rather than prior claims", () => {
    for (const p of golden.provenance) {
      const bytes = readFileSync(
        new URL(
          `../fixtures/w15/native/${p.revision.slice(0, 12)}/${p.path}`,
          import.meta.url,
        ),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(p.sha256);
      crossCheckNativeHistory(p.revision, p.path, bytes);
    }
  });
  for (const kind of ["plane", "sphere", "cylinder", "cone", "torus"] as const)
    it(`${kind}: exact topology and f32 attributes <=1e-5`, () =>
      compare(
        f.generatePrimitive(kind, {
          resolution: [2, 2],
          rings: 6,
          radialSegments: kind === "torus" ? 6 : 8,
          heightSegments: 2,
          tubeSegments: 4,
        }),
        golden.cases[kind],
      ));
  it("native ribbon taper and joins", () =>
    compare(
      f.generateRibbon(path, { widthStart: 0.4, widthEnd: 0.2 }),
      golden.cases.ribbon,
    ));
  it("native tube parallel transport, counts and caps", () =>
    compare(
      f.generateTube(path, {
        radiusStart: 0.4,
        radiusEnd: 0.2,
        radialSegments: 8,
      }),
      golden.cases.tube,
    ));
  it("Loop subdivision matches native geometry and oriented topology", () =>
    compare(f.subdivideMesh(plane()), golden.cases.subdivision, true));
  it("native displacement and normal recomputation", () =>
    compare(f.displaceProcedural(plane(), 0.2, 2), golden.cases.displacement));
  it("native pivot, reflection and inverse-transpose", () =>
    compare(f.scaleMesh(plane(), [-2, 3, 1], [1, 0, 0]), golden.cases.scale));
  it("native adaptive global refinement matches topology and attributes", () =>
    compare(
      f.subdivideMeshAdaptive(plane(), { maxEdgeLength: 0.2, maxLevels: 3 }),
      golden.cases.adaptive,
      true,
    ));
  it("native weld output", () =>
    compare(f.weldMesh(plane()).mesh, golden.cases.weld));
  it("native spherical unwrap uses bounding-box radius", () =>
    compare(
      f.sphericalMeshUv({
        positions: new Float32Array(golden.cases.sphere.positions),
        normals: new Float32Array(golden.cases.sphere.normals),
        indices: new Uint32Array(golden.cases.sphere.indices),
      }),
      golden.cases.sphericalUv,
    ));
  for (const mirror of [false, true])
    it(`native TBN ${mirror ? "mirrored" : "ordinary"} matches tangent xyz and handedness`, () => {
      const m = plane();
      if (mirror)
        for (let i = 0; i < m.uvs.length; i += 2) m.uvs[i] = 1 - m.uvs[i]!;
      const actual = f.attachMeshTangents(m),
        expected = golden.cases[mirror ? "tbnMirrored" : "tbnPlane"];
      compare(actual, expected);
      expect(maximum(actual.tangents, expected.tangents)).toBeLessThanOrEqual(
        1e-5,
      );
    });
});
describe("W15 geometry and mesh contracts", () => {
  it("textured HLOD preserves UVs and transformed TBN and rejects destructive simplification", () => {
    const mesh = f.attachMeshTangents(plane()),
      transforms = Float32Array.from([
        ...f.makeScatterTransform([0, 0, 0]),
        ...f.makeScatterTransform([2, 0, 0]),
      ]);
    const cluster = new f.MeshLayer(mesh, {
      transforms,
      hlod: { distance: 10, clusterRadius: 100, simplifyRatio: 1 },
    })
      .toBatch()
      .snapshot().clusters[0]!.mesh;
    expect(cluster.uvs!.length).toBe(mesh.uvs.length * 2);
    expect(cluster.tangents!.length).toBe(mesh.tangents.length * 2);
    expect(
      () =>
        new f.MeshLayer(mesh, {
          transforms,
          hlod: { distance: 10, clusterRadius: 100, simplifyRatio: 0.5 },
        }),
    ).toThrow(f.Forge3DError);
  });
  it("planar UV displacement equals native XY sampling and bevel depth/width is consistent", () => {
    const mesh = f.planarMeshUv(plane()),
      options = {
        width: 2,
        height: 2,
        heights: new Float32Array([0, 1, 2, 3]),
        scale: 0.05,
      };
    expect(
      f.displaceHeightmap(mesh, { ...options, uvSpace: true }).positions,
    ).toEqual(
      f.displaceHeightmap(mesh, { ...options, uvSpace: false }).positions,
    );
    const ribbon = f.generateThickPolyline(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      0.2,
      { depthOffset: 0.01, joinStyle: "bevel" },
    );
    for (let i = 0; i < 3; i++)
      expect(
        Math.hypot(
          ...[0, 1, 2].map(
            (a) =>
              ribbon.positions[i * 6 + a]! - ribbon.positions[i * 6 + 3 + a]!,
          ),
        ),
      ).toBeCloseTo(0.2, 5);
    expect(ribbon.positions[2]).toBeCloseTo(0.01, 6);
  });
  it("adaptive curvature selects native global levels and retains creases", () => {
    const m = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 1, 0, 3]),
    };
    expect(
      f.subdivideMeshAdaptive(m, {
        curvatureThreshold: Math.PI / 6,
        maxLevels: 3,
      }).indices.length,
    ).toBe(96);
    expect(f.subdivideMeshAdaptive(m).positions).toEqual(m.positions);
  });
  it("unit box has per-face normals/UVs and a closed geometric boundary", () => {
    const m = f.generatePrimitive("box");
    expect(m.positions.length / 3).toBe(24);
    expect(m.indices.length / 3).toBe(12);
    expect(f.meshBounds(m)).toEqual({
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
    });
    expect(
      f.validateMesh(f.weldMesh({ ...m, uvs: new Float32Array() }).mesh)
        .boundaryEdges,
    ).toBe(0);
  });
  it("square extrusion preserves native 24 vertices / 12 triangles", () => {
    const m = f.extrudePolygon(
      [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
      ],
      { height: 3 },
    );
    expect(m.positions.length / 3).toBe(24);
    expect(m.indices.length / 3).toBe(12);
    expect(f.meshBounds(m)?.max).toEqual([2, 2, 3]);
  });
  it("extrusion honors courtyards, concavity, winding and negative height", () => {
    const m = f.extrudePolygon(
      [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        [
          [1, 1],
          [1, 3],
          [3, 3],
          [3, 1],
        ],
      ],
      { height: -2 },
    );
    let area = 0;
    for (let i = 0; i < m.indices.length; i += 3) {
      const ids = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
      if (ids.every((id) => m.positions[id * 3 + 2] === -2)) {
        const [a, b, c] = ids.map((id) => [
          m.positions[id * 3]!,
          m.positions[id * 3 + 1]!,
        ]);
        area +=
          Math.abs(
            (b![0]! - a![0]!) * (c![1]! - a![1]!) -
              (b![1]! - a![1]!) * (c![0]! - a![0]!),
          ) / 2;
      }
    }
    expect(area).toBeCloseTo(12, 5);
    expect(f.meshBounds(m)?.min[2]).toBe(-2);
    expect(
      f.extrudePolygon([
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 2],
          [0, 2],
        ],
      ]).indices.length,
    ).toBeGreaterThan(0);
  });
  it("TBN is orthonormal, handed and preserved across affine reflection", () => {
    const m = f.attachMeshTangents(plane()),
      scaled = f.scaleMesh(m, [-2, 3, 1]);
    expect(m.tangents.length).toBe((m.positions.length / 3) * 4);
    for (let i = 0; i < scaled.tangents.length; i += 4) {
      expect(Math.hypot(...scaled.tangents.subarray(i, i + 3))).toBeCloseTo(
        1,
        5,
      );
      expect(scaled.tangents[i + 3]).toBe(-m.tangents[i + 3]!);
    }
  });
  it("weld preserves UV seams and removes collapsed triangles deterministically", () => {
    const m = {
      positions: new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 2, 3, 0, 1, 2]),
      uvs: new Float32Array([0, 0, 1, 1, 1, 0, 0, 1]),
    };
    expect(f.weldMesh(m).collapsed).toBe(0);
    const result = f.weldMesh({ ...m, uvs: new Float32Array() });
    expect([...result.remap]).toEqual([0, 0, 1, 2]);
    expect([...result.mesh.indices]).toEqual([0, 1, 2]);
    expect(result.collapsed).toBe(1);
  });
  it("validation diagnoses invalid indices, duplicates, degenerates and non-manifold edges", () => {
    const m = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0,
      ]),
      indices: new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4, 0, 0, 2, 9, 1, 2]),
    };
    const r = f.validateMesh(m);
    expect(r.clean).toBe(false);
    for (const kind of [
      "index-out-of-bounds",
      "duplicate-vertex",
      "degenerate-triangle",
      "non-manifold-edge",
    ])
      expect(r.issues.some((i) => i.kind === kind)).toBe(true);
  });
  it("boundary/crease subdivision, adaptive refinement and budgets", () => {
    const m = plane();
    expect(f.subdivideMesh(m, { levels: 0 })).toEqual(m);
    expect(f.subdivideMesh(m, { creases: [[0, 1]] }).indices.length).toBe(
      m.indices.length * 4,
    );
    expect(
      f.subdivideMeshAdaptive(m, { maxEdgeLength: 0.2, maxLevels: 3 }).indices
        .length,
    ).toBeGreaterThan(m.indices.length);
    expect(() => f.subdivideMesh(m, { levels: 10, maxBytes: 10000 })).toThrow();
  });
  it("heightmap sampling uses UVs, clamps and recomputes normals", () => {
    const m = f.displaceHeightmap(plane(), {
      width: 2,
      height: 2,
      heights: new Float32Array([0, 1, 2, 3]),
      scale: 2,
    });
    expect(m.positions[2]).toBe(4);
    expect(m.positions[26]).toBe(2);
    expect(m.normals.every(Number.isFinite)).toBe(true);
  });
  it("transforms reject singularity and retain ownership", () => {
    const m = plane(),
      before = m.positions.slice();
    expect(() => f.scaleMesh(m, [1, 0, 1])).toThrow();
    expect(f.meshBounds(f.centerMesh(m, [2, 3, 4]))?.min).toEqual([
      1.5, 2.5, 4,
    ]);
    expect(f.swapMeshAxes(m, 0, 2).indices[1]).toBe(m.indices[2]);
    expect(m.positions).toEqual(before);
  });
  it("UV unwrap and merge retain shape and offsets", () => {
    const a = f.sphericalMeshUv(f.generatePrimitive("sphere"));
    expect(a.uvs.every((x) => x >= 0 && x <= 1)).toBe(true);
    const b = f.planarMeshUv(plane()),
      merged = f.mergeMeshes([b, b]);
    expect(merged.positions.length).toBe(b.positions.length * 2);
    expect(merged.indices[b.indices.length]).toBe(
      b.indices[0]! + b.positions.length / 3,
    );
  });
  it("QEM reduces actual topology; LOD bounds stay in original bounds", () => {
    const m = f.generatePrimitive("sphere", { rings: 6, radialSegments: 8 }),
      levels = f.generateMeshLods(m, [1, 0.5, 0.25]),
      b = f.meshBounds(m)!;
    expect(levels[1]!.indices.length).toBeLessThan(m.indices.length);
    for (const level of levels) {
      const lb = f.meshBounds(level)!;
      for (let a = 0; a < 3; a++) {
        expect(lb.min[a]!).toBeGreaterThanOrEqual(b.min[a]! - 1e-5);
        expect(lb.max[a]!).toBeLessThanOrEqual(b.max[a]! + 1e-5);
      }
    }
  });
  it("worker fallback uses the actual W02 contract", async () => {
    const pool = new f.Forge3DWorkerPool({
      mainThreadHandler: createHandler(),
    });
    try {
      const result = await pool.run<MeshBuffers>({
        kind: "subdivide",
        mesh: plane(),
        levels: 1,
      });
      expect(result.indices.length).toBe(96);
    } finally {
      pool.dispose();
    }
    function createHandler() {
      return f.createMeshWorkerHandler();
    }
  });
  it("transfer detaches only dedicated copies and disposal releases CPU ownership", () => {
    const m = plane(),
      packet = f.transferMesh(m),
      copy = structuredClone(packet.mesh, { transfer: packet.transfer });
    expect(packet.mesh.positions.byteLength).toBe(0);
    expect(copy.positions).toEqual(m.positions);
    expect(m.positions.byteLength).toBeGreaterThan(0);
    const layer = new f.MeshLayer(m);
    expect(layer.cpuBytes).toBeGreaterThan(0);
    expect(layer.toBatch().instanceCount).toBe(1);
    layer.dispose();
    expect(layer.cpuBytes).toBe(0);
    expect(() => layer.mesh()).toThrow();
  });
  it("dtype, dimensions, path, and non-finite input are typed errors", () => {
    for (const fn of [
      () => f.generatePrimitive("sphere", { rings: 1.2 }),
      () => f.extrudePolygon([]),
      () =>
        f.generateTube([
          [0, 0, 0],
          [0, 0, 0],
        ]),
      () =>
        f.extrudePolygon([
          [
            [0, 0],
            [1, 0],
          ],
        ]),
      () =>
        f.cloneMesh({
          positions: new Float32Array([NaN, 0, 0]),
          indices: new Uint32Array(),
        }),
      () => f.generatePrimitive("plane", { resolution: [4096, 4096] }),
    ])
      expect(fn).toThrow(f.Forge3DError);
  });
});
