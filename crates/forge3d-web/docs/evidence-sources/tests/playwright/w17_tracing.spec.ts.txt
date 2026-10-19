import { test, expect } from "../browser/webgpu-fixture";
declare global {
  interface Window {
    __w17: any;
  }
}
test("W17 dist: 600-second installed full-scene local stress", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.FORGE3D_W17_SOAK !== "1",
    "Enable with --soak on the installed-package gate",
  );
  test.setTimeout(720000);
  page.on("console", (m) => {
    if (m.text().startsWith("W17 soak")) console.log(m.text());
  });
  await page.goto("/examples/tracing.html?dist");
  await page.waitForFunction(() => !!window.__w17);
  const r = await page.evaluate(async () => {
    const f = await import(/* @vite-ignore */ "/examples/w17-soak.js");
    return f.runTraceSoak(window.__w17, 600);
  });
  await testInfo.attach("trace-soak.json", {
    body: JSON.stringify(r, null, 2),
    contentType: "application/json",
  });
  expect(r.elapsedMs).toBeGreaterThanOrEqual(600000);
  expect(r.residualBuffers).toBe(0);
  expect(r.createdBuffers).toBe(r.destroyedBuffers);
  expect(r.frames).toBeGreaterThan(256);
  expect(r.cameraKeys).toBe(256);
  expect(r.coverageMin).toBeGreaterThan(0);
  expect(r.replayErrors).toBe(0);
  expect(r.residualBytes).toBe(0);
  expect(r.cpuPeak).toBeLessThanOrEqual(1024 * 1024 * 1024);
  expect(r.gpuPeak).toBeLessThanOrEqual(2048 * 1024 * 1024);
});
for (const dist of [false, true]) {
  const label = dist ? "dist" : "source";
  const open = async (page: any) => {
    await page.goto(`/examples/tracing.html${dist ? "?dist" : ""}`);
    await page.waitForFunction(() => !!window.__w17);
  };
  test(`W17 ${label}: interactive example renders a nonblank image`, async ({
    page,
  }, testInfo) => {
    // Allow cold shader compilation and all 64 full-resolution SDF samples on macOS CI.
    test.setTimeout(360000);
    await open(page);
    await page.getByRole("button", { name: "Render 64 samples" }).click();
    await expect(page.locator("#status")).toHaveText("64 / 64 samples", {
      timeout: 300000,
    });
    const range = await page.evaluate(() => {
      const v = document
        .querySelector("canvas")!
        .getContext("2d")!
        .getImageData(0, 0, 320, 200).data;
      let lo = 255,
        hi = 0;
      for (let i = 0; i < v.length; i += 4) {
        lo = Math.min(lo, v[i]!);
        hi = Math.max(hi, v[i]!);
      }
      return hi - lo;
    });
    expect(range).toBeGreaterThan(30);
    await testInfo.attach("tracing-example.png", {
      body: await page.locator("canvas").screenshot(),
      contentType: "image/png",
    });
  });
  test(`W17 ${label}: ReSTIR reuse, online guiding, RGB media, GGX/glass and area lights`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(async () => {
      const f = await import(/* @vite-ignore */ "/examples/w17-features.js");
      return f.runTraceFeatures(window.__w17);
    });
    await testInfo.attach("trace-features.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    expect(r.varianceReduction).toBeGreaterThan(0.4);
    expect(r.reuseChanged).toBe(true);
    expect(r.guidingUpdates).toBeGreaterThan(100);
    for (let c = 0; c < 3; c++)
      expect(Math.abs(r.mediumMean[c] - r.mediumExpected[c])).toBeLessThan(
        0.03,
      );
    expect(r.clampMax).toBeLessThanOrEqual(2.00001);
    for (const m of r.materials) {
      expect(m.same, JSON.stringify(m)).toBe(true);
      expect(m.finite).toBe(true);
      expect(m.covered).toBeGreaterThan(50);
      expect(m.cpuRelativeError).toBeLessThan(0.001);
    }
    expect(r.anisotropyChangesImage).toBe(true);
    expect(r.zeroRoughness).toBe(true);
    expect(r.materials[0].directMax).toBeGreaterThan(0.01);
    expect(r.materials[2].directMax).toBeGreaterThan(0.01);
    expect(r.guideRestored).toBe(true);
    expect(r.guideContinuation).toBe(true);
    expect(r.areaMean).toBeGreaterThan(0.1);
    expect(r.continuationMax).toBe(0);
  });
  test(`W17 ${label}: scattering media preserve exact engine phase results`, async ({ page }, testInfo) => {
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(async () => {
      const s = window.__w17;
      const { sha256 } = await import(/* @vite-ignore */ "/examples/w17-fixture.js");
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter!.requestDevice();
      const tracers = [];
      try {
        const scene = {
          environment: [0, 0, 0],
          lights: [{ position: [1, 0, 3], intensity: 100 }],
          medium: {
            sigmaA: [0.02, 0.04, 0.06],
            sigmaS: [0.5, 0.4, 0.3],
            g: 0.3,
            bounds: { min: [-100, -100, 0], max: [100, 100, 4] },
          },
        };
        const cases = [];
        for (const maxBounces of [1, 2, 3]) {
          const results = [];
          for (const engine of ["megakernel", "wavefront", "cpu"]) {
            const t = await s.PathTracer.create({
              width: 16, height: 16, seed: 42, maxBounces,
              camera: { origin: [0, 0, 5], target: [0, 0, 0], fovY: 0.01 },
              ...(engine === "cpu" ? { backend: "cpu" } : { engine }),
            }, { device });
            tracers.push(t);
            await t.setScene(scene);
            results.push(await t.render({ spp: 4 }));
          }
          const [a, b, c] = results;
          const error = (x: Float32Array, y: Float32Array) => x.reduce(
            (m, v, i) => Math.max(m, Math.abs(v - y[i]) / Math.max(1, Math.abs(v))), 0,
          );
          cases.push({
            maxBounces,
            same: (await sha256(a.color)) === (await sha256(b.color)),
            engines: error(a.color, b.color),
            cpu: error(c.color, a.color),
            mean: a.color.reduce((sum: number, v: number) => sum + v, 0) / a.color.length,
            finite: results.every((v) => v.color.every(Number.isFinite)),
            direct: error(a.direct, b.direct),
            indirect: error(a.indirect, b.indirect),
          });
        }
        return cases;
      } finally {
        for (const t of tracers) t.dispose();
        device.destroy();
      }
    });
    await testInfo.attach("medium-engines.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    for (const result of r) {
      expect(result.finite).toBe(true);
      expect(result.mean).toBeGreaterThan(0.01);
      expect(result.cpu).toBeLessThan(0.001);
      expect(result.engines, JSON.stringify(r)).toBe(0);
      expect(result.direct, JSON.stringify(r)).toBe(0);
      expect(result.indirect, JSON.stringify(r)).toBe(0);
      expect(result.same).toBe(true);
    }
  });
  test(`W17 ${label}: review regressions cover irregular BVHs, lit media, reuse and guiding parity`, async ({
    page,
  }, testInfo) => {
    // The seed ensemble and GPU readbacks run serially, including cold pipelines.
    test.setTimeout(600000);
    page.on("console", (message) => {
      if (message.text().startsWith("W17 review")) console.log(message.text());
    });
    await open(page);
    const r = await page.evaluate(async () => {
      const f = await import(/* @vite-ignore */ "/examples/w17-review.js");
      return f.runReviewRegressions(window.__w17);
    });
    await testInfo.attach("review-regressions.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    expect(r.probes).toBeGreaterThan(500);
    expect(r.invalidLeaves).toBe(0);
    expect(r.refitStable).toBe(true);
    expect(r.maxT).toBeLessThanOrEqual(1e-5);
    expect(r.maxBary).toBeLessThanOrEqual(1e-5);
    expect(r.maxOracle).toBeLessThanOrEqual(1e-5);
    for (const p of r.parity) {
      expect(p.cpu).toBeLessThan(0.001);
      expect(p.engines).toBe(0);
      expect(p.covered).toBeGreaterThan(100);
    }
    expect(Math.abs(r.reuseMean / r.reuseExpected - 1)).toBeLessThan(0.05);
    expect(r.reuseVarianceRatio).toBeLessThan(0.75);
    expect(Math.abs(r.absorptionRatio - r.absorptionExpected)).toBeLessThan(
      0.015,
    );
    expect(r.mediumParity.mean).toBeGreaterThan(0.01);
    expect(r.mediumParity.cpu).toBeLessThan(0.001);
    expect(r.mediumParity.engines).toBe(0);
    expect(r.positiveMass).toBeGreaterThan(0.75);
    expect(r.negativeMass).toBeLessThan(0.25);
    expect(r.guidingVarianceRatio).toBeLessThan(0.5);
    expect(r.aovRoundtripError).toBeLessThan(1e-5);
    expect(r.visibilityPng).toBe(true);
    expect(r.tileCoverage).toBe(187);
    expect(r.guidingParity).toBeLessThan(0.001);
    expect(r.guidingWeightsError).toBeLessThan(0.001);
    expect(r.axisError).toBeLessThan(0.001);
    expect(r.createdBuffers).toBeGreaterThan(100);
    expect(r.createdBuffers).toBe(r.destroyedBuffers);
    expect(r.residualBuffers).toBe(0);
    expect(r.residualBytes).toBe(0);
    expect(r.leakNegativeControl).toBe(true);
  });
  test(`W17 ${label}: guided CPU and GPU paths agree at every trained sample`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(async () => {
      const f = await import(/* @vite-ignore */ "/examples/w17-review.js");
      return f.runGuidingParity(window.__w17);
    });
    await testInfo.attach("guiding-parity.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    expect(r.checkpoints).toHaveLength(96);
    expect(r.boundary.cpuBins).toEqual([7]);
    expect(r.boundary.gpuBins).toEqual([7]);
    for (const p of r.checkpoints) {
      expect(p.covered).toBe(32 * 24);
      expect(p.trained).toBeGreaterThan(100);
      expect(p.color, `color at seed ${p.seed}, spp ${p.spp}`).toBeLessThan(
        0.00001,
      );
      expect(p.weights, `weights at seed ${p.seed}, spp ${p.spp}`).toBeLessThan(
        0.00001,
      );
      expect(p.engines).toBe(0);
      expect(p.engineWeights).toBe(0);
    }
  });
  test(`W17 ${label}: failed recovery and device loss during compilation release real buffers`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    await open(page);
    const r = await page.evaluate(async () => {
      const s = window.__w17,
        adapter = await navigator.gpu.requestAdapter(),
        device = await adapter!.requestDevice(),
        tracker = (
          await import(/* @vite-ignore */ "/examples/w17-memory.js")
        ).trackGpuBuffers(device);
      const t = await s.PathTracer.create({ width: 2, height: 2 }, { device });
      const gpu = navigator.gpu,
        request = Object.getOwnPropertyDescriptor(gpu, "requestAdapter");
      let recovery, blocked;
      try {
        Object.defineProperty(gpu, "requestAdapter", {
          configurable: true,
          value: async () => null,
        });
        try {
          await t.recover();
        } catch (e: any) {
          recovery = e.code;
        }
        try {
          await t.render();
        } catch (e: any) {
          blocked = e.code;
        }
      } finally {
        if (request) Object.defineProperty(gpu, "requestAdapter", request);
        else delete (gpu as any).requestAdapter;
      }
      await t.recover(device);
      await t.render();
      t.dispose();
      const recoveryResidual = tracker.count;
      tracker.restore();
      device.destroy();
      const dying =
          await (await navigator.gpu.requestAdapter())!.requestDevice(),
        allocation = (
          await import(/* @vite-ignore */ "/examples/w17-memory.js")
        ).trackGpuBuffers(dying),
        compile = dying.createComputePipelineAsync.bind(dying);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => (enter = r)),
        gate = new Promise<void>((r) => (release = r));
      Object.defineProperty(dying, "createComputePipelineAsync", {
        configurable: true,
        value: async (desc: GPUComputePipelineDescriptor) => {
          enter();
          await gate;
          return compile(desc);
        },
      });
      const pending = s.PathTracer.create(
        { width: 2, height: 2 },
        { device: dying },
      );
      await entered;
      dying.destroy();
      await dying.lost;
      release();
      let loss;
      try {
        await pending;
      } catch (e: any) {
        loss = e.code;
      }
      const result = {
        recovery,
        blocked,
        recoveryResidual,
        loss,
        created: allocation.created,
        destroyed: allocation.destroyed,
        residual: allocation.count,
      };
      allocation.restore();
      return result;
    });
    await testInfo.attach("recovery-compilation.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    expect(r.recovery).toBe("WEBGPU_ADAPTER_UNAVAILABLE");
    expect(r.blocked).toBe("DEVICE_LOST");
    expect(r.recoveryResidual).toBe(0);
    expect(r.loss).toBe("DEVICE_LOST");
    expect(r.created).toBeGreaterThanOrEqual(10);
    expect(r.created).toBe(r.destroyed);
    expect(r.residual).toBe(0);
  });
  test(`W17 ${label}: full trace-sdf-v1 analytic CPU/WASM/GPU workload`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600000);
    page.on("console", (m) => {
      if (m.text().startsWith("W17 workload")) console.log(m.text());
    });
    await open(page);
    const r = await page.evaluate(async () => {
      const f = await import(/* @vite-ignore */ "/examples/w17-fixture.js");
      return f.runTraceWorkload(window.__w17);
    });
    await testInfo.attach("trace-sdf-v1.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    expect([r.triangles, r.sdfPrimitives, r.rays]).toEqual([
      65536, 128, 1048576,
    ]);
    expect(r.triangleHash).toBe(r.expectedTriangleHash);
    expect([r.lowerLayerProbes, r.sdfHitProbes]).toEqual([64, 128]);
    expect(r.rayHash).toBe(r.expectedRayHash);
    expect(r.cpuHitHash).toBe(r.expectedHitHash);
    expect(r.wasmHitHash).toBe(r.expectedHitHash);
    expect(r.gpuHitHash).toBe(r.expectedHitHash);
    expect([r.idErrors, r.analyticErrors, r.materialErrors]).toEqual([0, 0, 0]);
    expect(r.maxT).toBeLessThanOrEqual(1e-5);
    expect(r.maxBary).toBeLessThanOrEqual(1e-5);
    expect(r.maxSdf).toBeLessThanOrEqual(1e-4);
    expect(r.sdfOffCenterProbes).toBe(512);
  });
  test(`W17 ${label}: CPU/WASM/GPU BVH hits, LBVH radix and topology-preserving refit`, async ({
    page,
  }) => {
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(async () => {
      const s = window.__w17,
        tri = (z: number, id: number) => ({
          v0: [-1, -1, z],
          v1: [1, -1, z],
          v2: [0, 1, z],
          id,
        }),
        triangles = Array.from({ length: 64 }, (_, i) => tri(-i * 2, i + 1));
      const rays = [
          { origin: [0, 0, 5], direction: [0, 0, -1] },
          { origin: [3, 0, 5], direction: [0, 0, -1] },
          { origin: [0, 0, -3], direction: [0, 0, -2] },
        ],
        cpu = s.buildBvh(triangles),
        wasm = await s.buildBvhWasm(triangles),
        gpu = await s.buildBvhGpu(triangles);
      const expected = rays.map((r) => cpu.intersect(r)),
        wasmHits = rays.map((r) => wasm.intersect(r)),
        gpuTree = rays.map((r) => gpu.intersect(r)),
        hits = await s.traceRaysGpu({ triangles }, rays);
      const topology = gpu.nodes.map((n: any) => [
        n.left,
        n.right,
        n.first,
        n.count,
      ]);
      await s.refitBvhGpu(
        gpu,
        triangles.map((t: any) => ({
          ...t,
          v0: [...t.v0.slice(0, 2), t.v0[2] - 10],
          v1: [...t.v1.slice(0, 2), t.v1[2] - 10],
          v2: [...t.v2.slice(0, 2), t.v2[2] - 10],
        })),
      );
      const refit = gpu.intersect(rays[0]),
        stable =
          JSON.stringify(topology) ===
          JSON.stringify(
            gpu.nodes.map((n: any) => [n.left, n.right, n.first, n.count]),
          );
      const backends = [
        cpu.stats.backend,
        wasm.stats.backend,
        gpu.stats.backend,
      ];
      cpu.dispose();
      wasm.dispose();
      gpu.dispose();
      return { expected, wasmHits, gpuTree, hits, refit, stable, backends };
    });
    expect(r.backends).toEqual(["cpu", "wasm", "webgpu"]);
    expect(r.stable).toBe(true);
    expect(r.refit.t).toBeCloseTo(15, 5);
    for (const copies of [r.wasmHits, r.gpuTree, r.hits])
      for (let i = 0; i < r.expected.length; i++) {
        expect(copies[i]?.id).toBe(r.expected[i]?.id);
        if (r.expected[i]) {
          expect(Math.abs(copies[i].t - r.expected[i].t)).toBeLessThanOrEqual(
            1e-5,
          );
          for (let c = 0; c < 3; c++)
            expect(
              Math.abs(copies[i].barycentric[c] - r.expected[i].barycentric[c]),
            ).toBeLessThanOrEqual(1e-5);
        }
      }
  });
  test(`W17 ${label}: all SDF primitives/CSG distances and material IDs match CPU/WASM/GPU`, async ({
    page,
  }) => {
    test.setTimeout(180000);
    await open(page);
    const result = await page.evaluate(async () => {
      const s = window.__w17,
        primitives = [
          s.SdfPrimitive.sphere([0, 0, 0], 1, 0xffffffff),
          s.SdfPrimitive.box([0, 0, 0], [1, 2, 1], 2),
          s.SdfPrimitive.cylinder([0, 0, 0], 1, 2, 3),
          s.SdfPrimitive.plane([0, 1, 0], 0, 4),
          s.SdfPrimitive.torus([0, 0, 0], 2, 0.5, 5),
          s.SdfPrimitive.capsule([-1, 0, 0], [1, 0, 0], 0.5, 6),
        ];
      const points = Array.from({ length: 64 }, (_, i) => [
          ((i % 4) - 1.5) * 0.6,
          ((Math.floor(i / 4) % 4) - 1.5) * 0.6,
          (Math.floor(i / 16) - 1.5) * 0.6,
        ]),
        scenes = primitives.map((p) => s.SdfScene.singlePrimitive(p));
      for (let op = 0; op < 6; op++) {
        const scene = new s.SdfScene(),
          a = scene.addPrimitive(primitives[0]),
          b = scene.addPrimitive(primitives[1]);
        scene.addOperation(op, a, b, 0.2);
        scenes.push(scene);
      }
      let maxWasm = 0,
        maxGpu = 0,
        materials = true;
      for (const scene of scenes) {
        const cpu = points.map((p) => scene.evaluate(p)),
          wasm = await s.evaluateSdfWasm(scene, points),
          gpu = await s.evaluateSdfGpu(scene, points);
        for (let i = 0; i < points.length; i++) {
          maxWasm = Math.max(
            maxWasm,
            Math.abs(cpu[i].distance - wasm[i].distance),
          );
          maxGpu = Math.max(
            maxGpu,
            Math.abs(cpu[i].distance - gpu[i].distance),
          );
          materials &&=
            cpu[i].materialId === wasm[i].materialId &&
            cpu[i].materialId === gpu[i].materialId;
        }
        scene.dispose();
      }
      return { maxWasm, maxGpu, materials };
    });
    expect(result.materials).toBe(true);
    expect(result.maxWasm).toBeLessThanOrEqual(1e-5);
    expect(result.maxGpu).toBeLessThanOrEqual(1e-4);
  });
  test(`W17 ${label}: megakernel/wavefront exact hashes, covered AOVs and convergence ladder`, async ({
    page,
  }, testInfo) => {
    page.on("console", (message) => {
      if (message.text().startsWith("W17 phase")) console.log(message.text());
    });
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(async () => {
      const s = window.__w17,
        options = {
          width: 32,
          height: 20,
          seed: 1597463007,
          maxBounces: 2,
          camera: { origin: [0, 0, 5], target: [0, 0, 0] },
        },
        scene = (
          await import(/* @vite-ignore */ "/examples/w17-fixture.js")
        ).makeTraceFixture(s);
      const hash = async (data: Float32Array) =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", data.buffer)),
        )
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
      const adapter = await navigator.gpu.requestAdapter(),
        device = await adapter!.requestDevice();
      console.log("W17 phase create mega");
      const a = await s.PathTracer.create(
        { ...options, engine: "megakernel" },
        { device },
      );
      console.log("W17 phase create wave");
      const b = await s.PathTracer.create(
        { ...options, engine: "wavefront" },
        { device },
      );
      console.log("W17 phase scenes");
      await a.setScene(scene);
      await b.setScene(scene);
      const hashes = [],
        rmse = [];
      let covered = 0;
      const expected = 0.5 + 0.08 * 0.8 * (0.5 + 1 / (3 * Math.PI));
      let final: any;
      for (const spp of [1, 4, 16, 64]) {
        console.log("W17 phase mega " + spp);
        const r = await a.render({ spp });
        rmse.push(
          Math.sqrt(
            r.color.reduce(
              (sum: number, v: number) => sum + (v - expected) ** 2,
              0,
            ) / r.color.length,
          ),
        );
        hashes.push(await hash(r.color));
        final = r;
        covered = r.id.filter((v: number) => v !== 0).length;
      }
      console.log("W17 phase wave 64");
      const wave = await b.render({ spp: 64 }),
        repeat = await a.render({ spp: 64 });
      const mse = rmse[3] ** 2,
        variance =
          final.color.reduce(
            (sum: number, v: number) => sum + (v - expected) ** 2,
            0,
          ) / final.color.length,
        ssim = (
          await s.compareImages(
            final.color,
            new Float32Array(final.color.length).fill(expected),
            { width: 32, height: 20, channels: 3 },
          )
        ).ssim;
      const blankSsim = (
        await s.compareImages(
          new Float32Array(final.color.length),
          new Float32Array(final.color.length).fill(expected),
          { width: 32, height: 20, channels: 3 },
        )
      ).ssim;
      const c = await s.PathTracer.create({ ...options, backend: "cpu" });
      await c.setScene(scene);
      const cpu = await c.render({ spp: 64 });
      let cpuMax = 0,
        waveMax = 0,
        waveDifferent = 0;
      for (let i = 0; i < cpu.color.length; i++)
        cpuMax = Math.max(cpuMax, Math.abs(cpu.color[i] - final.color[i]));
      for (let i = 0; i < wave.color.length; i++) {
        waveMax = Math.max(waveMax, Math.abs(wave.color[i] - final.color[i]));
        if (wave.color[i] !== final.color[i]) waveDifferent++;
      }
      const cpuIds = cpu.id.every(
        (id: number, i: number) => id === final.id[i],
      );
      const result = {
        hashes,
        waveHash: await hash(wave.color),
        repeatHash: await hash(repeat.color),
        rmse,
        ssim,
        blankSsim,
        mse,
        covered,
        cpuMax,
        waveMax,
        waveDifferent,
        cpuIds,
        normal: [...final.normal.slice(0, 3)],
        depth: final.depth[0],
        varianceFinite: final.variance.every(Number.isFinite),
      };
      a.dispose();
      b.dispose();
      c.dispose();
      scene.sdf.dispose();
      device.destroy();
      return result;
    });
    await testInfo.attach("trace-convergence.json", {
      body: JSON.stringify(r, null, 2),
      contentType: "application/json",
    });
    expect(r.blankSsim).toBeLessThan(0.1);
    expect(r.covered).toBe(640);
    expect(r.cpuIds).toBe(true);
    expect(r.waveHash, JSON.stringify({
      waveMax: r.waveMax,
      waveDifferent: r.waveDifferent,
      cpuMax: r.cpuMax,
    })).toBe(r.hashes[3]);
    expect(r.repeatHash).toBe(r.hashes[3]);
    expect(r.cpuMax).toBeLessThanOrEqual(1e-5);
    for (let i = 1; i < 4; i++) expect(r.rmse[i]).toBeLessThan(r.rmse[i - 1]);
    expect(r.ssim).toBeGreaterThanOrEqual(0.98);
    expect(r.varianceFinite).toBe(true);
    expect(r.normal).toEqual([0, 0, 1]);
    expect(r.depth).toBeGreaterThan(5);
  });
  test(`W17 ${label}: typed limits, cancellation, cache, device loss/replay and 30 disposals`, async ({
    page,
  }) => {
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(async () => {
      const s = window.__w17,
        adapter = await navigator.gpu.requestAdapter(),
        device = await adapter!.requestDevice(),
        tracer = await s.PathTracer.create(
          { width: 8, height: 8, maxBounces: 2 },
          { device },
        );
      const scene = {
        sdf: s.SdfScene.singlePrimitive(s.SdfPrimitive.sphere([0, 0, 0], 1)),
        lights: [{ position: [2, 3, 4], intensity: 30 }],
        materials: [{ albedo: [0.8, 0.2, 0.1] }],
      };
      await tracer.setScene(scene);
      const pendingScene = tracer.setScene(scene);
      let mutationBusy;
      try {
        await tracer.setScene(scene);
      } catch (e: any) {
        mutationBusy = e.code;
      }
      await pendingScene;
      const liveBuffers = new Set<GPUBuffer>();
      const createBuffer = device.createBuffer.bind(device);
      Object.defineProperty(device, "createBuffer", {
        configurable: true,
        value: (descriptor: GPUBufferDescriptor) => {
          const b = createBuffer(descriptor),
            destroy = b.destroy.bind(b);
          liveBuffers.add(b);
          Object.defineProperty(b, "destroy", {
            value: () => {
              liveBuffers.delete(b);
              destroy();
            },
          });
          return b;
        },
      });
      let pendingDisposed;
      try {
        const dying = await s.PathTracer.create(
          { width: 2, height: 2 },
          { device },
        );
        const update = dying.setScene(scene);
        dying.dispose();
        try {
          await update;
        } catch (e: any) {
          pendingDisposed = e.code;
        }
      } finally {
        delete (device as any).createBuffer;
      }
      const pendingResidualBuffers = liveBuffers.size;
      const original = await tracer.render({ spp: 4 });
      tracer.enableSceneCache();
      await tracer.render({ spp: 1 });
      await tracer.render({ spp: 1 });
      const cache = tracer.cacheStats();
      const abort = new AbortController();
      abort.abort();
      let cancelled, limited, lost, nodeLimit, bindingLimit, midCancellation;
      const oversized = new s.SdfScene();
      for (let i = 0; i < 257; i++)
        oversized.addPrimitive(s.SdfPrimitive.sphere([i * 3, 0, 0], 1));
      try {
        await tracer.setScene({ sdf: oversized });
      } catch (e: any) {
        nodeLimit = e.code;
      }
      oversized.dispose();
      Object.defineProperty(device, "limits", {
        configurable: true,
        value: { maxStorageBuffersPerShaderStage: 7 },
      });
      try {
        await s.PathTracer.create({ width: 2, height: 2 }, { device });
      } catch (e: any) {
        bindingLimit = e.code;
      } finally {
        delete (device as any).limits;
      }
      const mid = new AbortController();
      try {
        for await (const u of tracer.progressive({
          spp: 4,
          signal: mid.signal,
        })) {
          mid.abort();
        }
      } catch (e: any) {
        midCancellation = e.code;
      }
      const afterCancellation = tracer.samples;
      try {
        await tracer.render({ signal: abort.signal });
      } catch (e: any) {
        cancelled = e.code;
      }
      try {
        await s.PathTracer.create({
          width: 1024,
          height: 1024,
          memoryBudgetBytes: 1024,
        });
      } catch (e: any) {
        limited = e.code;
      }
      device.destroy();
      await new Promise((r) => setTimeout(r, 100));
      try {
        await tracer.render({ spp: 2 });
      } catch (e: any) {
        lost = e.code;
      }
      await tracer.recover();
      const replay = await tracer.render({ spp: 4 });
      let replayMax = 0;
      for (let i = 0; i < original.color.length; i++)
        replayMax = Math.max(
          replayMax,
          Math.abs(original.color[i] - replay.color[i]),
        );
      tracer.dispose();
      const loopDevice =
          await (await navigator.gpu.requestAdapter())!.requestDevice(),
        tracker = (
          await import(/* @vite-ignore */ "/examples/w17-memory.js")
        ).trackGpuBuffers(loopDevice);
      let residual = 0;
      for (let i = 0; i < 30; i++) {
        const t = await s.PathTracer.create(
          { width: 2, height: 2 },
          { device: loopDevice },
        );
        await t.render();
        t.dispose();
        residual = Math.max(residual, tracker.bytes);
      }
      const disposalAllocationCount = tracker.created,
        disposalResidualBuffers = tracker.count;
      tracker.restore();
      loopDevice.destroy();
      scene.sdf.dispose();
      return {
        disposalAllocationCount,
        disposalResidualBuffers,
        cache,
        cancelled,
        limited,
        lost,
        replayMax,
        residual,
        nodeLimit,
        bindingLimit,
        midCancellation,
        afterCancellation,
        mutationBusy,
        pendingDisposed,
        pendingResidualBuffers,
      };
    });
    expect(r.cache.hits).toBe(1);
    expect(r.cancelled).toBe("REQUEST_CANCELLED");
    expect(r.limited).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.lost).toBe("DEVICE_LOST");
    expect(r.replayMax).toBe(0);
    expect(r.residual).toBe(0);
    expect(r.disposalAllocationCount).toBeGreaterThanOrEqual(300);
    expect(r.disposalResidualBuffers).toBe(0);
    expect(r.nodeLimit).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.bindingLimit).toBe("UNSUPPORTED_FEATURE");
    expect(r.midCancellation).toBe("REQUEST_CANCELLED");
    expect(r.afterCancellation).toBe(0);
    expect(r.mutationBusy).toBe("INVALID_INPUT");
    expect(r.pendingDisposed).toBe("RUNTIME_DISPOSED");
    expect(r.pendingResidualBuffers).toBe(0);
  });
}
