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
  const result = await page.evaluate((key) => window.__forge3dW06[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  return result;
}

test.describe("W06 readback, AOV/HDR/EXR, offline quality, frames and video", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
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
    // First frame has no previous camera; later frames carry camera motion.
    expect(r.motion[0]).toBe(0);
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
