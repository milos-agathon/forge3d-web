import { describe, it, expect, vi } from "vitest";
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
import {
  normalizeTraceMaterial,
  TraceScene,
} from "../../src-ts/trace-scene.js";
import { iterTraceTiles } from "../../src-ts/trace-output.js";
import { packTraceScene, traceUniform, TraceGpu } from "../../src-ts/trace-gpu.js";
import { packGuidingWeights } from "../../src-ts/trace-sampling.js";
import { traceCpuSample, mediumTransmittance } from "../../src-ts/trace-cpu.js";
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
    expect(normalizeTraceMaterial({ roughness: 0 })).toMatchObject({
      roughness: 0,
      ax: 0.0010000000474974513,
      ay: 0.0010000000474974513,
    });
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
  it("guiding chooses the next bin at a rounded CDF boundary", () => {
    const grid = new OnlineGuidingGrid(1, 1, 8),
      weights = new Float32Array([1, 10, 1, 9, 1, 1, 4, 1]);
    grid.restore(weights);
    // RNG-representable values. The old double CDF selected bin 5 at the
    // first boundary; a real GPU recomputing divisions selected bin 6 at the last.
    expect(grid.sample(0, 0, 0.8071428537368774).bin).toBe(6);
    expect(grid.sample(0, 0, 0.9464285373687744).bin).toBe(7);
    expect(grid.sample(0, 0, 0.9464285969734192).bin).toBe(7);
    const packed = packGuidingWeights(weights, 8);
    expect(packed.slice(0, 8)).toEqual(weights); // Cache keys retain raw weights.
    expect(packed[16 + 6]).toBe(0.9464285373687744);
    expect(grid.sample(0, 0, 0.9464285969734192).weight).toBe(
      2.3333332538604736,
    );
    grid.dispose();
    expect(() => grid.sample(0, 0, 0.5)).toThrow("disposed");
  });
  it("guiding uses float32 totals rather than double normalization", () => {
    const grid = new OnlineGuidingGrid(1, 1, 8);
    grid.restore(new Float32Array([16777216, 1, 1, 1, 1, 1, 1, 1]));
    expect(grid.pdf(0, 0)[0]).toBe(1);
    expect(grid.pdf(0, 0)[1]).toBe(2 ** -24);
    grid.dispose();
  });
  it("packed guiding cells support all bin widths and keep cell distributions separate", () => {
    for (const bins of [1, 3, 8, 64]) {
      const grid = new OnlineGuidingGrid(2, 1, bins),
        weights = grid.snapshot();
      weights[bins] = 32;
      grid.restore(weights);
      const packed = packGuidingWeights(weights, bins);
      expect(packed).toHaveLength(6 * bins);
      expect(packed.slice(0, bins)).toEqual(weights.slice(0, bins));
      expect(packed.slice(3 * bins, 4 * bins)).toEqual(weights.slice(bins));
      expect(Math.abs(packed[3 * bins - 1]! - 1)).toBeLessThanOrEqual(
        bins * 2 ** -23,
      );
      expect(Math.abs(packed[6 * bins - 1]! - 1)).toBeLessThanOrEqual(
        bins * 2 ** -23,
      );
      expect(grid.sample(0, 0, 0).bin).toBe(0);
      expect(grid.sample(0, 0, 1).bin).toBe(bins - 1);
      expect(() => grid.sample(0, 0, NaN)).toThrow("out of range");
      grid.dispose();
    }
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
  it("serializes pending scene mutations and disposal cannot revive a tracer", async () => {
    const t = await PathTracer.create({ width: 2, height: 2, backend: "cpu" });
    const pending = t.setScene({ triangles: [tri(0, 1)] });
    await expect(t.setScene({})).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "trace-busy" },
    });
    await pending;
    const disposed = t.setScene({ triangles: [tri(1, 1)] });
    t.dispose();
    await expect(disposed).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
    expect(t.memoryReport()).toMatchObject({
      cpuBytes: 0,
      gpuBytes: 0,
      cacheBytes: 0,
    });
    const rendering = await PathTracer.create({
      width: 2,
      height: 2,
      backend: "cpu",
    });
    const render = rendering.render();
    rendering.dispose();
    await expect(render).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
    expect(rendering.samples).toBe(0);
  });
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
    expect(continued).toEqual(fresh);
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

describe("W17 review regressions", () => {
  it("host scene packing pins material, light, triangle and SDF word offsets", () => {
    const sdf = SdfScene.singlePrimitive(
      SdfPrimitive.sphere([2, 3, 4], 0.7, 1),
    );
    const scene = new TraceScene({
      triangles: [
        { v0: [1, 2, 3], v1: [4, 5, 6], v2: [7, 8, 9], id: 17, materialId: 1 },
      ],
      sdf,
      materials: [
        {},
        {
          albedo: [0.2, 0.3, 0.4],
          metallic: 0.8,
          emission: [0.5, 0.6, 0.7],
          roughness: 0.4,
          ior: 1.4,
          ax: 0.1,
          ay: 0.6,
        },
      ],
      lights: [
        {
          type: "disc",
          position: [3, 4, 5],
          intensity: 7,
          color: [0.2, 0.4, 0.6],
          weight: 3,
          normal: [0, 0, -1],
          radius: 0.7,
        },
      ],
    });
    const p = packTraceScene(scene),
      f = new Float32Array(p.bytes),
      u = new Uint32Array(p.bytes),
      material = p.offsets1[1]! + 12,
      light = p.offsets1[2]!;
    expect([...f.subarray(material, material + 12)]).toEqual([
      ...new Float32Array([
        0.2, 0.3, 0.4, 0.8, 0.5, 0.6, 0.7, 0.4, 1.4, 0.1, 0.6, 0,
      ]),
    ]);
    expect([...f.subarray(light, light + 16)]).toEqual([
      ...new Float32Array([
        3, 4, 5, 7, 0.2, 0.4, 0.6, 3, 0, -1, 0, 2, 0, 0, -1, 0.7,
      ]),
    ]);
    const tri = p.offsets0[0]!,
      primitive = p.offsets0[3]!,
      node = p.offsets1[0]!;
    expect([...u.subarray(tri + 12, tri + 14)]).toEqual([17, 1]);
    expect([...f.subarray(tri, tri + 3)]).toEqual([1, 2, 3]);
    expect([...f.subarray(primitive + 4, primitive + 8)]).toEqual([
      ...new Float32Array([2, 3, 4, 0.7]),
    ]);
    expect(u[primitive + 1]).toBe(1);
    expect(u[node + 4]).toBe(1);
    expect(u[node + 5]).toBe(1);
    const uniform = traceUniform(scene, {
      width: 4,
      height: 4,
      seed: 42,
      maxBounces: 3,
      mode: "hybrid",
      clamp: 1.25,
      guiding: undefined,
      restir: undefined,
      camera: { origin: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fovY: 45 },
    }, p, 2);
    expect(new Float32Array(uniform)[42]).toBe(1.25);
    expect(new Uint32Array(uniform)[43]).toBe(0);
    scene.dispose();
    sdf.dispose();
  });

  it("scanline tile enumeration covers clipped edges exactly once", () => {
    const tiles = [...iterTraceTiles(17, 11, 4)],
      coverage = new Uint8Array(17 * 11);
    for (const t of tiles)
      for (let y = t.y; y < t.y + t.height; y++)
        for (let x = t.x; x < t.x + t.width; x++) coverage[y * 17 + x]++;
    expect(coverage.every((v) => v === 1)).toBe(true);
    expect(tiles.at(-1)).toEqual({ x: 16, y: 8, width: 1, height: 3 });
    expect(() => [...iterTraceTiles(17, 11, 0)]).toThrow();
  });

  it("equal explicit GGX axes override roughness for both evaluation and sampling", () => {
    const explicit = normalizeTraceMaterial({
      metallic: 1,
      roughness: 0.5,
      ax: 0.01,
      ay: 0.01,
    });
    const equivalent = normalizeTraceMaterial({ metallic: 1, roughness: 0.1 });
    const n: TraceVec3 = [0, 0, 1];
    expect(traceBrdf(explicit, n, n, n)).toEqual(
      traceBrdf(equivalent, n, n, n),
    );
    expect(
      sampleGgx(
        [0, 0, -1],
        n,
        explicit.albedo,
        0.5,
        0.4,
        0.3,
        explicit.ax,
        explicit.ay,
      ),
    ).toEqual(
      sampleGgx(
        [0, 0, -1],
        n,
        explicit.albedo,
        0.1,
        0.4,
        0.3,
        equivalent.ax,
        equivalent.ay,
      ),
    );
  });
  it("prepared/cloned trees avoid throwaway builds and empty leaves cannot recurse to root", () => {
    const b = BvhHandle.prepare([tri(0, 1), tri(-2, 2)]);
    expect(b.nodes).toHaveLength(1);
    expect(b.isCpu()).toBe(true);
    b.validatePrimitives();
    const properties = b.getProperties();
    properties.worldBounds.min[0] = 999;
    expect(b.worldBounds.min[0]).toBe(-1);
    const clone = b.clone();
    expect(
      clone.intersect({ origin: [0, 0, 5], direction: [0.02, 0.03, -1] })?.id,
    ).toBe(1);
    clone.nodes[0] = {
      min: [1e30, 1e30, 1e30],
      max: [-1e30, -1e30, -1e30],
      left: 0,
      right: 0,
      first: 0,
      count: 0,
    };
    expect(
      clone.intersect({ origin: [0, 0, 5], direction: [0.02, 0.03, -1] }),
    ).toBeUndefined();
    expect(b.intersect({ origin: [0, 0, 5], direction: [0, 0, -1] })?.id).toBe(
      1,
    );
    expect(
      SdfScene.singlePrimitive(SdfPrimitive.sphere([0, 0, 0], 1)).intersect({
        origin: [0, 0, 5],
        direction: [0, 0, -1],
      })?.id,
    ).toBe(0xffffffff);
    expect(() => new BvhHandle([tri(0, 0xffffffff)])).toThrow();
    b.dispose();
    clone.dispose();
  });
  it("worker ray/SDF responses transfer all data and preserve material bits and misses", async () => {
    const handler = createTraceWorkerHandler(),
      context = {
        signal: new AbortController().signal,
        requestId: "packet",
        reportProgress: () => {},
      } as any;
    const hits = (await handler(
      {
        kind: "trace-rays",
        triangles: [tri(0, 0xfffffffe)],
        rays: [
          { origin: [0, 0, 5], direction: [0, 0, -1] },
          { origin: [5, 5, 5], direction: [0, 0, -1] },
        ],
      },
      context,
    )) as any;
    const transferred = structuredClone(hits, { transfer: [hits.records] });
    expect(hits.records.byteLength).toBe(0);
    const words = new Uint32Array(transferred.records);
    expect([words[12], words[15], words[28]]).toEqual([0xfffffffe, 0, 0]);
    const sdf = SdfScene.singlePrimitive(
      SdfPrimitive.sphere([0, 0, 0], 1, 0xffffffff),
    );
    const packet = (await handler(
      {
        kind: "evaluate-sdf",
        scene: sdf.snapshot(),
        points: [[0.3, 0.4, 0.5]],
      },
      context,
    )) as any;
    const copy = structuredClone(packet, {
      transfer: [packet.distances.buffer, packet.materials.buffer],
    });
    expect(packet.distances.byteLength + packet.materials.byteLength).toBe(0);
    expect(copy.materials[0]).toBe(0xffffffff);
    expect(copy.distances[0]).toBeCloseTo(Math.sqrt(0.5) - 1, 6);
    sdf.dispose();
  });
  it("lit absorption attenuates camera and shadow paths, and scattering sees analytic lights", async () => {
    const options = {
      width: 1,
      height: 1,
      backend: "cpu" as const,
      seed: 123,
      maxBounces: 1,
      camera: {
        origin: [0, 0, 5] as TraceVec3,
        target: [0, 0, 0] as TraceVec3,
        fovY: 0.01,
      },
    };
    const base = {
      triangles: [
        {
          v0: [-100, -100, 0],
          v1: [100, -100, 0],
          v2: [0, 100, 0],
          id: 1,
        } as TraceTriangle,
      ],
      materials: [{ albedo: [1, 1, 1] as TraceVec3 }],
      lights: [{ position: [0, 0, 5] as TraceVec3, intensity: 100 }],
      environment: [0, 0, 0] as TraceVec3,
    };
    const medium = {
      sigmaA: [0.5, 0.5, 0.5] as TraceVec3,
      sigmaS: [0, 0, 0] as TraceVec3,
      bounds: {
        min: [-100, -100, 0] as TraceVec3,
        max: [100, 100, 2] as TraceVec3,
      },
    };
    const t = await PathTracer.create(options);
    await t.setScene(base);
    const clear = await t.render();
    const model = new TraceScene({ ...base, medium });
    const settings = {
      ...options,
      camera: { ...options.camera, up: [0, 1, 0] as TraceVec3 },
      mode: "hybrid" as const,
      clamp: 0,
      restir: undefined,
      guiding: undefined,
    };
    let fogMean = 0;
    for (let i = 0; i < 8192; i++)
      fogMean +=
        traceCpuSample(model, settings, 0, i, [emptyReservoir()]).record[0]! /
        8192;
    expect(fogMean / clear.color[0]!).toBeCloseTo(Math.exp(-2), 2);
    expect(mediumTransmittance(model, [0, 0, 0], [0, 0, 1], 5)[0]).toBeCloseTo(
      Math.exp(-1),
      6,
    );
    model.dispose();
    await t.setScene({
      environment: [0, 0, 0],
      lights: [{ position: [1, 0, 3], intensity: 100 }],
      medium: { ...medium, sigmaA: [0, 0, 0], sigmaS: [0.5, 0.5, 0.5] },
    });
    expect((await t.render({ spp: 128 })).color[0]).toBeGreaterThan(0.01);
    t.dispose();
  }, 20000);
  it("guiding ignores local direct light and credits the sampled continuation before clamping", () => {
    const grid = new OnlineGuidingGrid(1, 1, 4);
    const settings = {
      width: 1,
      height: 1,
      seed: 42,
      maxBounces: 2,
      camera: {
        origin: [0, 0, 5] as TraceVec3,
        target: [0, 0, 0] as TraceVec3,
        up: [0, 1, 0] as TraceVec3,
        fovY: 1,
      },
      mode: "hybrid" as const,
      clamp: 0,
      restir: undefined,
      guiding: grid,
    };
    const scene = new TraceScene({
      triangles: [
        { v0: [-100, -100, 0], v1: [100, -100, 0], v2: [0, 100, 0], id: 1 },
      ],
      lights: [{ position: [0, 0, 5], intensity: 100 }],
      environment: [0, 0, 0],
    });
    const direct = traceCpuSample(scene, settings, 0, 0, [emptyReservoir()]);
    expect(direct.record[0]).toBeGreaterThan(0);
    expect(direct.guidingWeight).toBe(0);
    const sky = new TraceScene({
      triangles: scene.bvh!.triangles,
      environment: [5, 5, 5],
    });
    const a = traceCpuSample(sky, settings, 0, 0, [emptyReservoir()]),
      b = traceCpuSample(sky, { ...settings, clamp: 0.01 }, 0, 0, [
        emptyReservoir(),
      ]);
    expect(a.guidingWeight).toBeGreaterThan(0);
    expect(a.guidingWeight).toBe(b.guidingWeight);
    expect(b.record[0]).toBeLessThan(a.record[0]!);
    grid.dispose();
    scene.dispose();
    sky.dispose();
  });
  it("failed GPU recovery and failed rollback remain unavailable until explicit recovery", async () => {
    const device = { destroy: vi.fn() } as unknown as GPUDevice;
    const create = vi.spyOn(TraceGpu, "create").mockImplementation(
      async () =>
        ({
          bytes: 0,
          packed: { bytes: new ArrayBuffer(0) },
          checkAlive: () => {},
          dispose: () => {},
          reset: () => {},
          sample: async () => new Float32Array(28),
          exportReservoirs: async () => new ArrayBuffer(80),
          restore: () => {},
        }) as unknown as TraceGpu,
    );
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
    try {
      const t = await PathTracer.create({ width: 1, height: 1 }, { device });
      await expect(t.recover()).rejects.toMatchObject({
        code: "WEBGPU_ADAPTER_UNAVAILABLE",
      });
      await expect(t.render()).rejects.toMatchObject({ code: "DEVICE_LOST" });
      await expect(t.progressive().next()).rejects.toMatchObject({
        code: "DEVICE_LOST",
      });
      await t.recover(device);
      await t.render();
      create
        .mockRejectedValueOnce(new Error("new pipeline failed"))
        .mockRejectedValueOnce(new Error("rollback failed"));
      await expect(t.setScene({})).rejects.toThrow("rollback failed");
      await expect(t.render()).rejects.toMatchObject({ code: "DEVICE_LOST" });
      t.dispose();
    } finally {
      create.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("render holds its lock continuously through cache export, including microtask mutations", async () => {
    let entered!: () => void, release!: () => void;
    const exporting = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (release = r));
    let t: PathTracer,
      accepted = 0;
    const gpu = {
      bytes: 0,
      packed: { bytes: new ArrayBuffer(0) },
      checkAlive: () => {},
      dispose: () => {},
      reset: () => {},
      sample: async () => {
        const data = new Float32Array(28);
        data[0] = 0.8;
        let left = 12;
        const mutate = () => {
          try {
            t.reset();
            accepted++;
          } catch {}
          if (--left) queueMicrotask(mutate);
        };
        queueMicrotask(mutate);
        return data;
      },
      exportReservoirs: async () => {
        entered();
        await blocked;
        return new ArrayBuffer(80);
      },
      restore: () => {},
    } as unknown as TraceGpu;
    const spy = vi.spyOn(TraceGpu, "create").mockResolvedValue(gpu);
    try {
      t = await PathTracer.create(
        { width: 1, height: 1 },
        { device: { destroy: () => {} } as GPUDevice },
      );
      t.enableSceneCache();
      const render = t.render();
      await exporting;
      expect(accepted).toBe(0);
      expect(() => t.reset()).toThrow("active");
      await expect(t.setScene({})).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      release();
      const result = await render;
      expect(t.samples).toBe(1);
      expect((await t.render()).color).toEqual(result.color);
      expect(t.cacheStats().hits).toBe(1);
      t.dispose();
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
