import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW06: Record<string, () => Promise<any>>;
  }
}

async function probe(page: import("../browser/webgpu-fixture").Page, name: string): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/examples/test-w06-capture.html");
  await page.waitForFunction(() => !!window.__forge3dW06);
  const result = await page.evaluate((key) => window.__forge3dW06[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  return result;
}

test.describe("W06 readback, AOV/HDR/EXR, offline quality, frames and video", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  for (const dist of [false, true]) test(`C08 ${dist ? 'dist' : 'source'}: capture compiles optional kernels only when requested`, async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__capturePipelines = [];
      for (const key of ['createComputePipeline', 'createRenderPipeline'] as const) {
        const original = GPUDevice.prototype[key];
        (GPUDevice.prototype as any)[key] = function (descriptor: any) {
          (window as any).__capturePipelines.push({ label: descriptor.label, entry: descriptor.fragment?.entryPoint });
          return (original as any).call(this, descriptor);
        };
      }
    });
    await page.goto('/examples/test-clear.html');
    const r = await page.evaluate(async dist => {
      const api = await (dist ? import('/dist/index.js') : import('/src-ts/index.ts'));
      const canvas = document.createElement('canvas'), runtime = await api.Forge3DRuntime.create(canvas, { width: 33, height: 31 });
      const scene = api.Forge3DScene.create();
      scene.addNode({ kind: 'ground-plane', name: 'ground', size: [4, 4], height: 0, color: [.4, .5, .6, 1] });
      const counts = () => {
        const calls = (window as any).__capturePipelines;
        return { denoise: calls.filter((c: any) => c.label === 'forge3d-web-offline-denoise').length,
          luminance: calls.filter((c: any) => c.label === 'forge3d-web-offline-luminance').length,
          surface: calls.filter((c: any) => c.entry === 'fs_capture_surface').length };
      };
      try {
        runtime.setScene(scene.snapshot());
        runtime.setCamera({ position: [0, 3, 3], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: .1, far: 20 });
        const plain = await runtime.capture({ samples: 1, aovs: ['depth'] }), before = counts();
        runtime.beginOfflineAccumulation({ samples: 1, aovs: ['albedo', 'normal', 'depth'] });
        await runtime.accumulateBatch(1);
        await runtime.resolveOfflineHdr({ denoise: { enabled: true, method: 'atrous', iterations: 1 } });
        await runtime.readAccumulationMetrics(.01, 8);
        const requested = counts();
        await runtime.resolveOfflineHdr({ denoise: { enabled: true, method: 'atrous', iterations: 1 } });
        await runtime.readAccumulationMetrics(.01, 8);
        return { before, requested, repeated: counts(), covered: [...plain.aovFrame.depth()].filter(d => d < 1).length };
      } finally { runtime.dispose(); scene.dispose(); }
    }, dist);
    expect(r.covered).toBeGreaterThan(200);
    expect(r.before).toEqual({ denoise: 0, luminance: 0, surface: 0 });
    expect(r.requested).toEqual({ denoise: 1, luminance: 1, surface: 1 });
    expect(r.repeated).toEqual(r.requested);
  });

  for (const dist of [false, true]) test(`C08 ${dist ? 'dist' : 'source'}: vector and scatter capture pipelines compile on demand and are reused`, async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(() => {
      (window as any).__geometryCapturePipelines = [];
      const original = GPUDevice.prototype.createRenderPipeline;
      GPUDevice.prototype.createRenderPipeline = function (descriptor) {
        if (descriptor.label === 'scatter-pipeline' || ['fs_aov', 'fs_surface'].includes(descriptor.fragment?.entryPoint ?? ''))
          (window as any).__geometryCapturePipelines.push(descriptor.fragment?.entryPoint);
        return original.call(this, descriptor);
      };
    });
    await page.goto('/examples/test-clear.html');
    const r = await page.evaluate(async dist => {
      const api = await (dist ? import('/dist/index.js') : import('/src-ts/index.ts'));
      const runtime = await api.Forge3DRuntime.create(document.createElement('canvas'), { width: 96, height: 96 }), vectors = new api.VectorLayers();
      const counts = () => [...(window as any).__geometryCapturePipelines];
      try {
        runtime.setCamera({ position: [0, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: .1, far: 30 });
        vectors.add({ name: 'point', features: [{ id: 7, kind: 'point', position: [-1, .5, 0], style: { pointSize: 24, color: [1, 0, 0, .5] } }] });
        runtime.setVectorLayers(vectors);
        runtime.setScatterBatches([{ name: 'box', levels: [{ mesh: api.generatePrimitive('box') }], transforms: new Float32Array([1,0,0,1,0,1,0,.5,0,0,1,0,0,0,0,1]), color: [0,1,0,1] }]);
        await runtime.readRgba(); const display = counts();
        const plain = await runtime.capture({ samples: 1, aovs: ['depth', 'id'] }), depth = counts();
        const surface = await runtime.capture({ samples: 1, aovs: ['depth', 'id', 'normal', 'albedo'] }), requested = counts();
        const repeated = await runtime.capture({ samples: 1, aovs: ['depth', 'id', 'normal', 'albedo'] });
        return { display, depth, requested, repeated: counts(), ids: [...new Set(plain.aovFrame.id())],
          sameDepth: plain.aovFrame.depth().every((v, i) => v === surface.aovFrame.depth()[i]),
          sameSurface: surface.aovFrame.normal().every((v, i) => v === repeated.aovFrame.normal()[i]),
          normals: [...surface.aovFrame.normal()].some(v => Math.abs(v) > .5) };
      } finally { runtime.dispose(); vectors.dispose(); }
    }, dist);
    expect(r.display).toEqual(['fs_main']);
    expect(r.depth).toEqual(['fs_main', 'fs_capture_primary', 'fs_aov']);
    expect(r.requested).toEqual(['fs_main', 'fs_capture_primary', 'fs_aov', 'fs_capture_surface', 'fs_surface']);
    expect(r.repeated).toEqual(r.requested); expect(r.ids).toContain(0xffffffef);
    expect(r.ids.some(id => id >= 0x100000 && id < 0xffffffef)).toBe(true);
    expect(r.sameDepth).toBe(true); expect(r.sameSurface).toBe(true); expect(r.normals).toBe(true);
  });

  test("R02/C07: exact HDR, AOV, depth, ID and motion readback with padded rows", async ({ page }) => {
    const r = await probe(page, "analytic");
    // 67x45 exercises padded rows for every texel size (R32F, R32Uint, Rg32F).
    expect(r.sizes).toEqual({ frame: 67 * 45 * 4, hdr: 67 * 45 * 4, depth: 67 * 45, motion: 67 * 45 * 2 });
    expect(r.hdrMax).toBeGreaterThan(1);
    expect(r.hdrError).toBeLessThanOrEqual(1e-5);
    expect(r.albedo).toEqual([0.5, 0.25, 0.5]);
    expect(r.normal).toEqual([0, 1, 0]);
    expect(r.depthError).toBeLessThanOrEqual(1e-6);
    expect(r.linearDepthError).toBeLessThanOrEqual(1e-5);
    expect(r.id).toBe(r.expectedId);
    expect(r.backgroundId).toBe(0);
    expect(r.backgroundDepth).toBe(1);
    expect(r.backgroundHdr[0]).toBeCloseTo(0.1, 6);
    expect(r.overlayError).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(r.motion[0] - r.expectedMotion[0])).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(r.motion[1] - r.expectedMotion[1])).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(r.motion[0])).toBeGreaterThan(1);
    // The one-sample display tonemap reproduces the realtime frame.
    expect(r.displayMax).toBeLessThanOrEqual(1);
    expect(r.channels).toEqual(["albedo", "normal", "depth", "id", "motion"]);
  });

  test("C08: offline accumulation, adaptive convergence and native session semantics", async ({ page }) => {
    test.slow();
    const r = await probe(page, "offline");
    expect(r.deterministic).toBe(true);
    expect(r.samplesUsed).toEqual([16, 16]);
    expect(r.psnr.improved).toBeGreaterThan(r.psnr.baseline + 0.5);
    expect(r.manualBatch).toBe(1);
    expect(r.manualEqual).toBe(true);
    expect(r.displayMax).toBeLessThanOrEqual(1);
    expect(r.metricsBeforeSamples).toBe("INVALID_INPUT");
    expect(r.beginTwice.code).toBe("INVALID_INPUT");
    expect(r.beginTwice.message).toContain("already active");
    expect(r.renderDuring).toBe(false);
    expect(r.readDuring).toBe("INVALID_INPUT");
    expect(r.firstBatch).toBe(4);
    expect(r.metrics.totalSamples).toBe(4);
    expect(r.metrics.convergedTileRatio).toBe(0);
    expect(r.endReturned).toEqual([true, false]);
    expect(r.renderAfter).toBe(true);
    expect(r.adaptiveComplex.used).toBeGreaterThan(4);
    expect(r.adaptiveComplex.used).toBeLessThanOrEqual(12);
    expect(r.adaptiveComplex).toMatchObject({
      target: 12,
      allMax: true,
      positive: true,
      lastMatches: true,
      p95Matches: true,
      ratioMatches: true,
      denoiser: "none",
      adaptiveFlag: true,
    });
    expect(r.callbackThrow.message).toBe("stop after first progress update");
    expect(r.renderAfterThrow).toBe(true);
    expect(r.cancelled).toBe("REQUEST_CANCELLED");
    expect(r.renderAfterCancel).toBe(true);
    expect(r.disabledSettings).toBe("INVALID_INPUT");
    expect(r.flat.uniform).toBe(32);
    expect(r.flat.adaptive).toBeLessThan(r.flat.uniform);
    expect(r.flatRatios[0]).toBe(0);
    for (const ratio of r.flatRatios) {
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
    expect(r.flatRatios[2]).toBeGreaterThanOrEqual(r.flatRatios[0]);
  });

  test("C08: AOV-guided WebGPU denoiser meets the acceptance and matches the CPU reference", async ({ page }) => {
    test.slow();
    const r = await probe(page, "denoise");
    expect(r.after.ssim - r.before.ssim).toBeGreaterThanOrEqual(0.02);
    expect(r.after.mse).toBeLessThanOrEqual(r.before.mse * 0.8);
    expect(1 - r.regression.ssim).toBeLessThanOrEqual(0.005);
    expect(r.gpuCpuMaxAbs).toBeLessThanOrEqual(1e-4);
    expect(r.offline).toMatchObject({ denoiserUsed: "atrous", denoiserRequested: "atrous", denoiseGuides: ["albedo", "normal"] });
    expect(r.oidn.metadata.denoiserUsed).toBe("atrous");
    expect(r.oidn.metadata.warnings).toEqual(["oidn package not installed; falling back to atrous denoiser"]);
    expect(r.oidn.channels).toEqual([]);
  });

  test("C07: EXR channels, metadata, exact round trips and typed decode errors", async ({ page }) => {
    const r = await probe(page, "exr");
    expect(r.type).toBe("image/x-exr");
    expect(r.names).toEqual([
      "albedo.B", "albedo.G", "albedo.R", "beauty.A", "beauty.B", "beauty.G", "beauty.R",
      "depth.Z", "id", "motion.X", "motion.Y", "normal.X", "normal.Y", "normal.Z",
    ]);
    expect(r.size).toEqual([67, 45]);
    expect(r.software).toBe("forge3d-web");
    expect(r.metadata).toEqual({ "forge3d:far": "20", "forge3d:near": "0.5" });
    expect(r.beautyMax).toBe(0);
    expect(r.albedoMax).toBe(0);
    expect(r.depthMax).toBe(0);
    expect(r.idType).toBe("u32");
    expect(r.idEqual).toBe(true);
    expect(r.roundTripMax).toBe(0);
    expect(r.hdrCompression).toBe("piz");
    expect(r.hdrMetadata).toEqual({ "forge3d:test": "w06" });
    expect(r.malformed).toBe("INVALID_INPUT");
    expect(r.oversized).toBe("RESOURCE_LIMIT_EXCEEDED");
  });

  test("C08: GPU tonemap operators match the CPU reference", async ({ page }) => {
    test.slow();
    const r = await probe(page, "tonemap");
    for (const operator of ["display", "reinhard", "reinhard-extended", "aces", "uncharted2", "exposure", "filmic-terrain"]) {
      expect(r[operator].maxDiff, operator).toBeLessThanOrEqual(1);
      expect(r[operator].mean, operator).toBeGreaterThan(10);
    }
    expect(r.invalidOperator).toBe("INVALID_INPUT");
  });

  test("C05: deterministic frame sequences, progress, cancellation and sinks", async ({ page }) => {
    test.slow();
    const r = await probe(page, "frames");
    expect(r.frameCount).toBe(13);
    expect(r.summary.frames).toBe(13);
    expect(r.summary.timestampsUs).toEqual(
      Array.from({ length: 13 }, (_, i) => Math.round((i * 1e6) / 12)),
    );
    expect(r.names).toEqual(Array.from({ length: 13 }, (_, i) => `frame_${String(i).padStart(4, "0")}.png`));
    expect(r.pngSignature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(r.progress.map((p: number[]) => p[0])).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(r.progress.every((p: number[]) => p[1] === 13)).toBe(true);
    // First frame has no previous camera (identical matrices, zero motion up
    // to float evaluation noise); later frames carry camera motion.
    expect(r.motion[0]).toBeLessThanOrEqual(1e-3);
    expect(r.motion[1]).toBeGreaterThan(0.1);
    expect(r.displayVsCapture).toBeLessThanOrEqual(1);
    expect(r.cancelled).toBe("REQUEST_CANCELLED");
    expect(r.seen).toBe(3);
    expect(r.renderAfterCancel).toBe(true);
    if (r.opfs.supported) {
      expect(r.opfs.names).toEqual(["shot_0000.png", "shot_0001.png", "shot_0002.png"]);
      expect(r.opfs.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    expect(r.downloads).toEqual([["frame_0000.png", "image/png"], ["frame_0001.png", "image/png"]]);
    expect(r.dumpCount).toBe(2);
    expect(r.dumperNames).toEqual(["render_0000.png", "render_0001.png"]);
    expect(r.dumperErrors).toEqual(["INVALID_INPUT", "INVALID_INPUT"]);
    expect(r.pngDeterministic).toBe(true);
    expect(r.pngDecodeMax).toBe(0);
  });

  test("C06: WebCodecs video with exact timestamps, deterministic muxing and typed diagnostics", async ({ page }) => {
    test.slow();
    const r = await probe(page, "video");
    expect(r.frames).toBe(13);
    const expected = Array.from({ length: 13 }, (_, i) => Math.round((i * 1e6) / 12));
    for (const [name, container] of [["mp4", r.mp4], ["webm", r.webm]] as const) {
      if (container.ok) {
        expect(container.frameCount, name).toBe(13);
        expect(container.timestampsUs, name).toEqual(expected);
        expect(container.durationUs, name).toBe(Math.round((13 * 1e6) / 12));
        expect(container.keyFrames, name).toBeGreaterThanOrEqual(3);
        expect(container.demuxed.length, name).toBe(13);
        // WebM stores millisecond timestamps; MP4 keeps the fps timescale.
        const tolerance = name === "webm" ? 500 : 1;
        container.demuxed.forEach((value: number, index: number) => {
          expect(Math.abs(value - expected[index]!), `${name}[${index}]`).toBeLessThanOrEqual(tolerance);
        });
      } else {
        expect(container.code, name).toBe("UNSUPPORTED_FEATURE");
        expect(container.details.kind, name).toBe("video-codec-unavailable");
      }
    }
    expect(r.muxDeterministic).toEqual({ webm: true, mp4: true });
    expect(r.unavailable.code).toBe("UNSUPPORTED_FEATURE");
    expect(r.unavailable.details.kind).toBe("video-codec-unavailable");
    expect(r.unavailable.details.webCodecs).toBe(false);
    expect(r.unavailable.details.probes.every((p: any) => p.reason === "webcodecs-unavailable")).toBe(true);
    expect(r.badContainer).toBe("INVALID_INPUT");
  });

  test("native golden: W04 capture beauty and AOVs match native render_with_aov", async ({ page }) => {
    test.slow();
    const r = await probe(page, "parity");
    expect(r.beauty.ssim).toBeGreaterThanOrEqual(0.98);
    expect(r.albedo.ssim).toBeGreaterThanOrEqual(0.98);
    expect(r.normal.ssim).toBeGreaterThanOrEqual(0.98);
    expect(r.depth.ssim).toBeGreaterThanOrEqual(0.98);
    // Native AOVs are binary16; normals and depth agree at that precision.
    expect(r.normal.maxAbs).toBeLessThanOrEqual(1e-3);
    expect(r.depth.maxAbs).toBeLessThanOrEqual(1e-6);
    expect(r.manifestClip).toEqual([0.1, 6000]);
  });

  test("offline-denoise-v1 fixture at 1920x1080", async ({ page }) => {
    test.setTimeout(600_000);
    const r = await probe(page, "fixture");
    expect(r.exact.size).toEqual([1920, 1080]);
    expect(r.exact.covered).toBeGreaterThan(100_000);
    expect(r.exact.colorMax).toBeLessThanOrEqual(1e-5);
    expect(r.exact.aovMax).toBeLessThanOrEqual(1e-5);
    expect(r.exact.depthMax).toBeLessThanOrEqual(1e-6);
    expect(r.ladder[1].used).toBe(1);
    expect(r.ladder[4].used).toBe(4);
    expect(r.ladder[16].used).toBe(16);
    expect(r.ladder[4].psnr).toBeGreaterThan(r.ladder[1].psnr);
    expect(r.ladder[16].psnr).toBeGreaterThan(r.ladder[4].psnr);
    expect(r.denoise.size).toEqual([1920, 1080]);
    expect(r.denoise.after.ssim - r.denoise.before.ssim).toBeGreaterThanOrEqual(0.02);
    expect(r.denoise.after.mse).toBeLessThanOrEqual(r.denoise.before.mse * 0.8);
    expect(1 - r.denoise.regression.ssim).toBeLessThanOrEqual(0.005);
    expect(r.denoise.gpuCpuMaxAbs).toBeLessThanOrEqual(1e-4);
    expect(r.stream).toMatchObject({ count: 120, blank: 0, exact: true, last: Math.round((119 * 1e6) / 30) });
    expect(r.stream.memoryAfter).toBe(r.stream.memoryBefore);
  });

  test("device loss during offline rendering reports DEVICE_LOST and recovers", async ({ page }) => {
    test.slow();
    const r = await probe(page, "deviceLoss");
    expect(r.failure.code).toBe("DEVICE_LOST");
    expect(r.runtimes).toBe(2);
    expect(r.status).toBe("ready");
    expect(r.recoveredSize).toEqual([96, 64]);
    expect(r.recoveredDepth).toBe(true);
  });

  test("30 capture cycles return memory to baseline", async ({ page }) => {
    test.slow();
    const r = await probe(page, "memory");
    expect(r.after).toBe(r.baseline);
    // Capture targets (52+ bytes/pixel) and accumulation are accounted while open.
    expect(r.during).toBeGreaterThan(r.baseline + 67 * 45 * 52);
    expect(r.endedFlag).toBe(true);
    expect(r.ended).toBe(r.baseline);
    expect(r.peak).toBeGreaterThan(r.baseline);
  });
});
