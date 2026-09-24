import { describe, expect, it } from "vitest";

import { AovFrame, Frame, HdrFrame } from "../../src-ts/frames.js";
import {
  DenoiseSettings,
  hasUpwardConvergenceTrend,
  nativeBeginOptions,
  nativeResolveOptions,
  normalizeAovSelection,
  OfflineProgress,
  OfflineQualitySettings,
  renderOffline,
  type OfflineRenderTarget,
} from "../../src-ts/offline.js";
import type {
  CaptureResult,
  OfflineAccumulationOptions,
  OfflineMetrics,
  OfflineResolveOptions,
} from "../../src-ts/index.js";

function metrics(total: number, ratio: number, p95 = 1): OfflineMetrics {
  return { totalSamples: total, meanDelta: p95, p95Delta: p95, maxTileDelta: p95, convergedTileRatio: ratio };
}

class FakeTarget implements OfflineRenderTarget {
  total = 0;
  began: OfflineAccumulationOptions | undefined;
  resolved: OfflineResolveOptions | undefined;
  batches: number[] = [];
  ended = 0;
  constructor(readonly ratios: number[] = []) {}

  beginOfflineAccumulation(options: OfflineAccumulationOptions = {}): void {
    this.began = options;
  }

  async accumulateBatch(count: number) {
    this.batches.push(count);
    this.total += count;
    return { totalSamples: this.total, batchTimeMs: 1 };
  }

  async readAccumulationMetrics(): Promise<OfflineMetrics> {
    const ratio = this.ratios[Math.min(this.batches.length - 1, this.ratios.length - 1)] ?? 0;
    return metrics(this.total, ratio, 1 - ratio);
  }

  async resolveOfflineHdr(options: OfflineResolveOptions = {}): Promise<CaptureResult> {
    this.resolved = options;
    const result = {
      frame: new Frame(1, 1, new Uint8Array([1, 2, 3, 255])),
      hdrFrame: new HdrFrame(1, 1, new Float32Array([0.1, 0.2, 0.3, 1])),
      aovFrame: new AovFrame({
        width: 1,
        height: 1,
        near: 0.1,
        far: 10,
        albedo: new Float32Array([0.5, 0.5, 0.5]),
        normal: new Float32Array([0, 1, 0]),
        depth: new Float32Array([0.5]),
      }),
      denoiseGuides: options.denoise ? ["albedo", "normal"] : [],
    };
    return result;
  }

  endOfflineAccumulation(): boolean {
    this.ended += 1;
    return true;
  }
}

describe("W06 offline settings (native TV12 / M5 validation)", () => {
  it("uses native defaults and rejects invalid policies", () => {
    const settings = new OfflineQualitySettings();
    expect(settings.toJSON()).toEqual({
      enabled: false,
      adaptive: false,
      targetVariance: 0.001,
      maxSamples: 64,
      minSamples: 4,
      batchSize: 4,
      tileSize: 16,
      convergenceRatio: 0.95,
    });
    expect(Object.isFrozen(settings)).toBe(true);
    for (const bad of [
      { targetVariance: -1 },
      { maxSamples: 0 },
      { minSamples: 0 },
      { minSamples: 8, maxSamples: 4 },
      { batchSize: 0 },
      { tileSize: 0 },
      { convergenceRatio: 1.5 },
      { maxSamples: 1.5 },
    ]) {
      expect(() => new OfflineQualitySettings(bad), JSON.stringify(bad)).toThrow(/must/);
    }
  });

  it("validates denoise settings like the native dataclass", () => {
    const denoise = new DenoiseSettings();
    expect(denoise.toJSON()).toMatchObject({
      enabled: false,
      method: "atrous",
      iterations: 3,
      sigmaColor: 0.1,
      sigmaNormal: 0.1,
      sigmaDepth: 0.1,
      edgeStopping: 1,
      guides: { albedo: true, normal: true, depth: false },
    });
    expect(denoise.active).toBe(false);
    expect(new DenoiseSettings({ enabled: true, method: "none" }).active).toBe(false);
    expect(() => new DenoiseSettings({ method: "bogus" as never })).toThrow(/method must be one of/);
    expect(() => new DenoiseSettings({ iterations: 0 })).toThrow(/>= 1/);
    expect(() => new DenoiseSettings({ iterations: 11 })).toThrow(/<= 10/);
    expect(() => new DenoiseSettings({ sigmaColor: -0.1 })).toThrow(/sigmaColor must be >= 0/);
    expect(new DenoiseSettings({ enabled: true }).toNative()).toMatchObject({ iterations: 3, edgeStopping: 1 });
  });

  it("normalizes AOV selections and native begin/resolve payloads", () => {
    expect(normalizeAovSelection(undefined)).toEqual({ albedo: true, normal: true, depth: true, id: false, motion: false });
    expect(normalizeAovSelection("all")).toEqual({ albedo: true, normal: true, depth: true, id: true, motion: true });
    expect(() => normalizeAovSelection(["color" as never])).toThrow(/unknown AOV/);
    expect(nativeBeginOptions({ samples: 8, seed: 3, aovs: ["id"] })).toEqual({
      samples: 8,
      seed: 3,
      aovs: { albedo: false, normal: false, depth: false, id: true, motion: false },
    });
    expect(() => nativeBeginOptions({ samples: 0 })).toThrow(/samples/);
    expect(() => nativeBeginOptions({ seed: -1 })).toThrow(/seed/);
    expect(nativeResolveOptions({})).toEqual({ tonemap: { operator: "display", whitePoint: 4 }, denoise: null });
    expect(nativeResolveOptions({ denoise: { enabled: true } }).denoise).toMatchObject({ iterations: 3 });
    expect(nativeResolveOptions({ denoise: { enabled: false } }).denoise).toBeNull();
    expect(() => nativeResolveOptions({ tonemap: { operator: "filmic" as never } })).toThrow(/tonemap operator/);
    expect(() => nativeResolveOptions({ tonemap: { whitePoint: 0 } })).toThrow(/whitePoint/);
  });

  it("ports the native convergence trend window", () => {
    const history = (ratios: number[]) => ratios.map((ratio, i) => metrics(i + 1, ratio));
    expect(hasUpwardConvergenceTrend(history([0, 1]))).toBe(false);
    expect(hasUpwardConvergenceTrend(history([0, 0.5, 0.9]))).toBe(true);
    expect(hasUpwardConvergenceTrend(history([0.9, 0.5, 0.2]))).toBe(false);
    expect(hasUpwardConvergenceTrend(history([0.1, 0.9, 0.5, 0.6, 0.7]))).toBe(true);
  });
});

describe("renderOffline controller (native render_offline loop)", () => {
  it("requires explicit opt-in", async () => {
    await expect(renderOffline(new FakeTarget(), {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("renders aa_samples in batches without metrics when not adaptive", async () => {
    const target = new FakeTarget();
    const result = await renderOffline(target, { settings: { enabled: true, batchSize: 4 }, samples: 10, seed: 5 });
    expect(target.batches).toEqual([4, 4, 2]);
    expect(target.began).toMatchObject({ samples: 10, seed: 5 });
    expect(result.metadata).toMatchObject({
      samplesUsed: 10,
      targetSamples: 10,
      adaptive: false,
      denoiserUsed: "none",
      finalP95Delta: null,
      convergedRatio: null,
    });
    expect(target.ended).toBe(1);
  });

  it("stops adaptively on an upward trend after minSamples and reports progress", async () => {
    const target = new FakeTarget([0, 0.95, 0.96, 0.97]);
    const updates: OfflineProgress[] = [];
    const result = await renderOffline(target, {
      settings: { enabled: true, adaptive: true, maxSamples: 32, minSamples: 4, batchSize: 4, convergenceRatio: 0.9 },
      onProgress: (progress) => updates.push(progress),
    });
    expect(result.metadata.samplesUsed).toBe(12);
    expect(result.metadata.targetSamples).toBe(32);
    expect(updates.map((u) => u.samplesSoFar)).toEqual([4, 8, 12]);
    expect(updates.every((u) => u.maxSamples === 32)).toBe(true);
    expect(result.metadata.convergedRatio).toBeCloseTo(0.96);
  });

  it("ends the session when a progress callback throws or the signal aborts", async () => {
    const throwing = new FakeTarget();
    await expect(
      renderOffline(throwing, {
        settings: { enabled: true },
        samples: 8,
        onProgress: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(throwing.ended).toBe(1);

    const controller = new AbortController();
    const aborted = new FakeTarget();
    await expect(
      renderOffline(aborted, {
        settings: { enabled: true, batchSize: 1 },
        samples: 8,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.samplesSoFar === 2) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(aborted.total).toBe(2);
    expect(aborted.ended).toBe(1);
  });

  it("falls back from OIDN to the A-trous denoiser like native and adds guide AOVs", async () => {
    const target = new FakeTarget();
    const result = await renderOffline(target, {
      settings: { enabled: true },
      aovs: [],
      denoise: { enabled: true, method: "oidn" },
    });
    expect(result.metadata.denoiserUsed).toBe("atrous");
    expect(result.metadata.denoiserRequested).toBe("oidn");
    expect(result.metadata.warnings).toEqual(["oidn package not installed; falling back to atrous denoiser"]);
    expect(target.began?.aovs).toEqual(["albedo", "normal"]);
    // Guide-only channels are trimmed from the returned AOV frame.
    expect(result.aovFrame.channels()).toEqual([]);
    expect(target.resolved?.denoise).toBeInstanceOf(DenoiseSettings);
  });
});
