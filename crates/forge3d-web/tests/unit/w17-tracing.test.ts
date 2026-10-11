import { describe, it, expect } from "vitest";
import { BvhHandle } from "../../src-ts/bvh.js";
import {
  SdfPrimitive,
  SdfScene,
  SdfSceneBuilder,
  CsgOperation,
  evaluateCsg,
} from "../../src-ts/sdf.js";
import { PathTracer } from "../../src-ts/path-tracer.js";
import {
  AliasTable,
  OnlineGuidingGrid,
  hgPhase,
  sampleHg,
  RestirDI,
  emptyReservoir,
  updateReservoir,
  mergeReservoir,
  reservoirWeight,
} from "../../src-ts/trace-sampling.js";
import { TraceRng, sampleSeed } from "../../src-ts/trace-math.js";
import { createTraceWorkerHandler } from "../../src-ts/trace-worker.js";
import type { TraceTriangle, TraceVec3 } from "../../src-ts/trace-types.js";
import {
  sampleDielectric,
  sampleGgx,
  mediumRatio,
  traceBrdf,
} from "../../src-ts/trace-bsdf.js";
import { normalizeTraceMaterial } from "../../src-ts/trace-scene.js";
const tri = (z: number, id: number): TraceTriangle => ({
  v0: [-1, -1, z],
  v1: [1, -1, z],
  v2: [0, 1, z],
  id,
});
describe("W17 native BVH/SDF contracts", () => {
  for (const method of ["sah", "lbvh"] as const)
    it(`${method} queries stable IDs, barycentrics and refits topology`, () => {
      const tree = new BvhHandle([tri(0, 7), tri(-2, 8)], {
        method,
        maxLeafSize: 1,
      });
      const ray = {
        origin: [0, 0, 5] as TraceVec3,
        direction: [0, 0, -1] as TraceVec3,
      };
      expect(tree.intersect(ray)).toMatchObject({
        id: 7,
        t: 5,
        barycentric: [0.25, 0.25, 0.5],
      });
      const topology = tree.nodes.map((n) => [
        n.left,
        n.right,
        n.first,
        n.count,
      ]);
      tree.refit([tri(-3, 7), tri(-2, 8)]);
      expect(tree.intersect(ray)?.id).toBe(8);
      expect(
        tree.nodes.map((n) => [n.left, n.right, n.first, n.count]),
      ).toEqual(topology);
      expect(() => tree.refit([tri(0, 7)])).toThrow("count");
      tree.dispose();
      expect(() => tree.intersect(ray)).toThrow("disposed");
    });
  it("rejects invalid inputs and enforces admission before allocating", () => {
    expect(() => new BvhHandle([])).toThrow("empty");
    expect(() => new BvhHandle([tri(0, 1), tri(1, 1)])).toThrow("unique");
    expect(() => new BvhHandle([tri(0, 1)], { memoryBudgetBytes: 1 })).toThrow(
      "limit",
    );
    expect(() => SdfPrimitive.plane([0, 0, 0], 0)).toThrow("normal");
    expect(() => SdfPrimitive.sphere([NaN, 0, 0], 1)).toThrow();
  });
  it("ports all six signed-distance primitives including degenerate capsule", () => {
    const cases: [SdfPrimitive, TraceVec3, number][] = [
      [SdfPrimitive.sphere([0, 0, 0], 1), [0, 0, 0], -1],
      [SdfPrimitive.box([0, 0, 0], [1, 1, 1]), [1, 1, 1], 0],
      [SdfPrimitive.cylinder([0, 0, 0], 1, 2), [0, 0, 0], -1],
      [SdfPrimitive.cylinder([0, 0, 0], 1, 2), [2, 0, 0], 1],
      [SdfPrimitive.plane([0, 1, 0], 0), [0, -1, 0], -1],
      [SdfPrimitive.torus([0, 0, 0], 2, 0.5), [2, 0, 0], -0.5],
      [SdfPrimitive.capsule([-1, 0, 0], [1, 0, 0], 0.5), [0, 0, 0], -0.5],
      [SdfPrimitive.capsule([0, 0, 0], [0, 0, 0], 1), [0, 0, 0], -1],
    ];
    for (const [p, x, d] of cases) expect(p.evaluate(x)).toBeCloseTo(d, 6);
  });
  it("CSG native material ties, all operations, DAG validation, bounds and clone", () => {
    const a = { distance: 0.5, materialId: 1 },
      b = { distance: 1, materialId: 2 };
    expect(evaluateCsg(0, a, b)).toEqual(a);
    expect(evaluateCsg(1, a, b)).toEqual(b);
    expect(evaluateCsg(2, a, b)).toEqual(a);
    expect(evaluateCsg(3, a, b, 0.1).materialId).toBe(2);
    expect(evaluateCsg(4, a, b, 0.1).materialId).toBe(2);
    expect(evaluateCsg(5, a, b, 0.1).materialId).toBe(1);
    const builder = new SdfSceneBuilder(),
      box = builder.addBox([0, 0, 0], [1, 1, 1], 1),
      sphere = builder.addSphere([0, 0, 0], 1.2, 2);
    builder.subtract(box, sphere);
    const scene = builder.withBounds([-2, -2, -2], [2, 2, 2]).build();
    expect(scene.evaluate([0, 0, 0])).toMatchObject({ materialId: 2 });
    expect(scene.evaluate([0, 0, 0]).distance).toBeGreaterThan(0);
    expect(scene.inBounds([3, 0, 0])).toBe(false);
    expect(SdfScene.fromSnapshot(scene.snapshot()).snapshot()).toEqual(
      scene.snapshot(),
    );
    expect(() => scene.addOperation(CsgOperation.Union, 99, 0)).toThrow();
    builder.reset();
    expect(builder.build().evaluate([0, 0, 0]).distance).toBe(Infinity);
  });
  it("sphere tracing works for outside/inside rays and unnormalized directions", () => {
    const scene = SdfScene.singlePrimitive(
      SdfPrimitive.sphere([0, 0, 0], 1, 42),
    );
    expect(scene.normal([0.6, 0, 0.8])).toEqual([
      Math.fround(0.6),
      0,
      Math.fround(0.8),
    ]);
    expect(new SdfScene().normal([0, 0, 0])).toEqual([0, 0, 0]);
    expect(
      scene.intersect({ origin: [0, 0, 5], direction: [0, 0, -2] }),
    ).toMatchObject({ materialId: 42, t: 2 });
    expect(
      scene.intersect({ origin: [0, 0, 0], direction: [1, 0, 0] })?.t,
    ).toBeCloseTo(1, 5);
  });
});
describe("W17 shipped sampling contracts", () => {
  it("anisotropic GGX changes scattering and preserves direct BRDF reciprocity", () => {
    const material = normalizeTraceMaterial({
      albedo: [0.7, 0.4, 0.2],
      metallic: 1,
      roughness: 0.3,
      ax: 0.1,
      ay: 0.7,
    });
    const n: TraceVec3 = [0, 0, 1],
      v: TraceVec3 = [0, 0, 1],
      l: TraceVec3 = [0.6, 0, 0.8];
    const a = traceBrdf(material, n, v, l),
      b = traceBrdf(material, n, l, v);
    for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c]!, 6);
    const normalIncidence = traceBrdf(material, n, v, v);
    for (let c = 0; c < 3; c++)
      expect(normalIncidence[c]).toBeCloseTo(
        material.albedo[c]! / (4 * Math.PI * 0.1 * 0.7),
        6,
      );
    const iso = sampleGgx([0, 0, -1], n, material.albedo, 0.3, 0.4, 0.2);
    const aniso = sampleGgx(
      [0, 0, -1],
      n,
      material.albedo,
      0.3,
      0.4,
      0.2,
      0.1,
      0.7,
    );
    expect(aniso.direction).not.toEqual(iso.direction);
    expect(aniso.weight.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(() => normalizeTraceMaterial({ ax: 0 })).toThrow();
  });
  it("dielectric total internal reflection, GGX weights and RGB majorant ratios", () => {
    const d: TraceVec3 = [Math.sqrt(0.75), 0, -0.5];
    expect(sampleDielectric(d, [0, 0, 1], false, 1.5, 0.99)[2]).toBeGreaterThan(
      0,
    );
    const sample = sampleGgx(
      [0, 0, -1],
      [0, 0, 1],
      [0.7, 0.4, 0.2],
      0.25,
      0.2,
      0.3,
    );
    expect(sample.direction[2]).toBeGreaterThan(0);
    expect(sample.weight.every((x) => x >= 0 && Number.isFinite(x))).toBe(true);
    expect(Math.hypot(...sample.direction)).toBeCloseTo(1, 6);
    expect(mediumRatio([0.2, 0.4, 0.6], 0.6, 2)).toEqual(
      new Float32Array([Math.exp(0.8), Math.exp(0.4), 1]).reduce<number[]>(
        (a, x) => [...a, x],
        [],
      ),
    );
  });
  it("native xorshift fixed-seed stream and pixel/sample independence", () => {
    const r = new TraceRng(42);
    expect([r.nextU32(), r.nextU32(), r.nextU32()]).toEqual([
      11355432, 2836018348, 476557059,
    ]);
    expect(sampleSeed(42, 0, 0)).not.toBe(sampleSeed(42, 0, 1));
  });
  it("weighted light alias distribution and deterministic reservoirs", () => {
    const alias = new AliasTable([10, 1]),
      rng = new TraceRng(5),
      counts = [0, 0];
    for (let i = 0; i < 11000; i++)
      counts[alias.sample(rng.next(), rng.next())!.index]++;
    expect(counts[0]! / counts[1]!).toBeGreaterThan(9);
    expect(counts[0]! / counts[1]!).toBeLessThan(11);
    const r = emptyReservoir();
    updateReservoir(r, 1, 2, 0.5, 0);
    expect(reservoirWeight(r)).toBe(2);
    const merged = emptyReservoir();
    mergeReservoir(merged, r, 1, 0);
    expect(merged.sample).toBe(1);
    expect(reservoirWeight(merged)).toBe(2);
    const biased = emptyReservoir();
    mergeReservoir(biased, r, 0, 0, false);
    expect(biased).toMatchObject({
      sample: 1,
      weightSum: 4,
      selectedTarget: 0,
      count: 1,
    });
    expect(new RestirDI().sampleLight(0.5, 0.5)).toBeUndefined();
  });
  it("native guiding grid uniform prior, updates and disposal", () => {
    const grid = new OnlineGuidingGrid(2, 2, 4);
    expect(Array.from(grid.pdf(0, 0))).toEqual([0.25, 0.25, 0.25, 0.25]);
    for (let i = 0; i < 16; i++) grid.update(0, 0, 1, 1);
    expect(grid.pdf(0, 0)[1]).toBeGreaterThan(0.5);
    expect(grid.pdf(0, 0).reduce((a, b) => a + b)).toBeCloseTo(1, 6);
    grid.dispose();
    expect(() => grid.pdf(0, 0)).toThrow("disposed");
  });
  it("HG normalized for all shipped anisotropies and sampler PDF consistency", () => {
    for (const g of [-0.8, -0.2, 0, 0.4, 0.8]) {
      let sum = 0;
      for (let i = 0; i < 50000; i++)
        sum += hgPhase(-1 + ((i + 0.5) * 2) / 50000, g);
      expect((sum * 4 * Math.PI) / 50000).toBeCloseTo(1, 3);
      const s = sampleHg(0.3, 0.7, g);
      expect(s.pdf).toBe(hgPhase(s.direction[2], g));
      expect(Math.hypot(...s.direction)).toBeCloseTo(1, 6);
    }
  });
});
describe("W17 progressive rendering/lifecycle", () => {
  it("reports unavailable WebGPU and admits the smaller explicit CPU working set", async () => {
    await expect(
      PathTracer.create({ width: 2, height: 2 }),
    ).rejects.toMatchObject({ code: "WEBGPU_UNAVAILABLE" });
    const t = await PathTracer.create({
      width: 32,
      height: 20,
      backend: "cpu",
      memoryBudgetBytes: 500000,
    });
    await t.render();
    expect(t.memoryReport().peakBytes).toBeLessThanOrEqual(500000);
    t.dispose();
  });
  it("worker query cancellation is handled between compute chunks", async () => {
    const controller = new AbortController(),
      handler = createTraceWorkerHandler(),
      context = {
        signal: controller.signal,
        requestId: "mid-query",
        reportProgress: () => {},
      } as any;
    const pending = handler(
      {
        kind: "trace-rays",
        triangles: [tri(0, 1)],
        rays: Array.from({ length: 4096 }, () => ({
          origin: [0, 0, 5],
          direction: [0, 0, -1],
        })),
      },
      context,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });
  it("cached guiding frames restore the PDF state before progressive continuation", async () => {
    const grid = new OnlineGuidingGrid(4, 4),
      t = await PathTracer.create({
        width: 4,
        height: 4,
        backend: "cpu",
        guiding: grid,
        maxBounces: 2,
      });
    await t.setScene({
      triangles: [
        { v0: [-100, -100, 0], v1: [100, -100, 0], v2: [0, 100, 0], id: 1 },
      ],
      lights: [{ position: [0, 0, 5], intensity: 20 }],
    });
    t.enableSceneCache();
    await t.render({ spp: 3 });
    const after = grid.snapshot();
    grid.reset();
    await t.render({ spp: 3 });
    expect(t.cacheStats().hits).toBe(1);
    expect(grid.snapshot()).toEqual(after);
    let continued;
    for await (const u of t.progressive()) continued = u.result;
    grid.reset();
    const fresh = await t.render({ spp: 4 });
    expect(continued!.color).toEqual(fresh.color);
    t.dispose();
    grid.dispose();
  });
  it("SDF snapshots preserve every uint32 material bit", () => {
    const scene = SdfScene.singlePrimitive(
      SdfPrimitive.sphere([0, 0, 0], 1, 0xffffffff),
    );
    expect(
      SdfScene.fromSnapshot(scene.snapshot()).evaluate([0, 0, 0]).materialId,
    ).toBe(0xffffffff);
  });
  it("renders geometry, stable AOVs, HDR, cache and bounded deterministic replay", async () => {
    const tracer = await PathTracer.create({
      width: 12,
      height: 8,
      backend: "cpu",
      seed: 42,
      maxBounces: 2,
    });
    const sdf = SdfScene.singlePrimitive(SdfPrimitive.sphere([0, 0, 0], 1));
    await tracer.setScene({ sdf });
    const first = await tracer.render({ spp: 4 }),
      second = await tracer.render({ spp: 4 });
    expect(second.color).toEqual(first.color);
    expect(first.id.some((id) => id !== 0)).toBe(true);
    expect(first.color.some((v) => v > 0)).toBe(true);
    expect(first.normal.every(Number.isFinite)).toBe(true);
    tracer.enableSceneCache(true);
    await tracer.render({ spp: 1 });
    const cached = await tracer.render({ spp: 1 });
    expect(tracer.cacheStats().hits).toBe(1);
    cached.color.fill(99);
    expect((await tracer.render({ spp: 1 })).color[0]).not.toBe(99);
    expect((await tracer.renderHdr()).data).toHaveLength(12 * 8 * 4);
    tracer.dispose();
    expect(tracer.memoryReport().cpuBytes).toBe(0);
    expect(tracer.memoryReport().cacheBytes).toBe(0);
    await expect(tracer.render()).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
  it("iterator break releases session, and cancellation restarts cleanly", async () => {
    const tracer = await PathTracer.create({
      width: 4,
      height: 4,
      backend: "cpu",
    });
    for await (const p of tracer.progressive({ spp: 4 })) {
      expect(p.samples).toBe(1);
      break;
    }
    expect(tracer.samples).toBe(1);
    await tracer.render();
    const controller = new AbortController();
    for await (const p of tracer.progressive({
      spp: 4,
      signal: controller.signal,
    })) {
      expect(p.samples).toBeGreaterThan(0);
      controller.abort();
      await expect(tracer.render()).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      break;
    }
    const abort = new AbortController();
    abort.abort();
    await expect(tracer.render({ signal: abort.signal })).rejects.toMatchObject(
      { code: "REQUEST_CANCELLED" },
    );
    tracer.dispose();
  });
  it("worker handler uses W02 cancellation and returns transferable packets", async () => {
    const handler = createTraceWorkerHandler(),
      controller = new AbortController(),
      context = {
        signal: controller.signal,
        requestId: "1",
        reportProgress: () => {},
      } as any;
    const result = (await handler(
      { kind: "build-bvh", triangles: [tri(0, 1)] },
      context,
    )) as any;
    expect(result.nodes).toBeInstanceOf(ArrayBuffer);
    expect(result.indices).toBeInstanceOf(Uint32Array);
    controller.abort();
    await expect(
      handler({ kind: "build-bvh", triangles: [tri(0, 1)] }, context),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });
});
