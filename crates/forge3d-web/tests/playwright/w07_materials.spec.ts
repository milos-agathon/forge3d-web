import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW07: Record<string, (...args: any[]) => Promise<any>>;
  }
}

async function probe(page: import("../browser/webgpu-fixture").Page, name: string): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/examples/test-w07-materials.html");
  const result = await page.evaluate((key) => window.__forge3dW07[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  if (process.env.FORGE3D_W07_DEBUG) {
    if (result.variants) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(process.env.FORGE3D_W07_DEBUG, { recursive: true });
      for (const [id, entry] of Object.entries<any>(result.variants)) {
        console.log(
          `${id.padEnd(30)} ssim=${entry.ssim.toFixed(4)} mae=${entry.meanAbs.toFixed(3)} ` +
            `delta=${entry.delta?.toFixed(3)} native=${entry.nativeDelta}`,
        );
        if (entry.actualPng) {
          writeFileSync(
            `${process.env.FORGE3D_W07_DEBUG}/${id}.png`,
            Buffer.from(entry.actualPng.split(",")[1], "base64"),
          );
        }
      }
      console.log(JSON.stringify(result.zero));
      console.log(
        `fallbackAdapter=${result.fallbackAdapter} quadCoarseDerivatives=${result.quadCoarseDerivatives}`,
      );
    } else {
      console.log(name, JSON.stringify(result, null, 1).slice(0, 20000));
    }
  }
  return result;
}

test.describe("W07 terrain PBR/POM and layered materials", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  test("T05-T07: every native toggle matches its terrain-material-v1 golden", async ({ page }) => {
    test.slow();
    const r = await probe(page, "goldens");
    expect(Object.keys(r.variants).length).toBe(26);
    // The tv4 scene puts heightmap texel edges inside 2x2 quads, where the
    // native edge term (coarse normal derivatives) depends on the adapter's
    // coarse-derivative granularity: >= 0.994 SSIM where dpdxCoarse is
    // per-quad like the native oracle's adapter, ~0.88-0.90 on SwiftShader
    // and Metal. The historical 1f4084a POM golden sits at the 0.98 margin
    // even for the native oracle. Their SSIM is gated only on hardware
    // adapters with per-quad coarse derivatives; pixel deltas and
    // zero-feature identity still apply everywhere.
    const nativeDerivatives = !r.fallbackAdapter && r.quadCoarseDerivatives;
    for (const [id, entry] of Object.entries<any>(r.variants)) {
      const derivativeBound = id.startsWith("tv4-") || id === "pomh-material";
      if (nativeDerivatives || !derivativeBound) {
        expect(entry.ssim, `${id} SSIM vs native golden`).toBeGreaterThanOrEqual(r.ssimMin);
      }
      if (entry.minDelta !== null) {
        expect(entry.delta, `${id} pixel delta vs its baseline`).toBeGreaterThanOrEqual(entry.minDelta);
      }
    }
    // Zero-feature material preserves the unmaterialed baseline within the
    // native TV4/TV10 criterion (max difference <= 1 LSB).
    for (const [id, zero] of Object.entries<any>(r.zero)) {
      expect(zero.maxDiff, `${id} zero-feature identity`).toBeLessThanOrEqual(1);
    }
  });

  test("validation, fallback diagnostics and the material report", async ({ page }) => {
    const r = await probe(page, "contracts");
    expect(r.defaults.albedoMode).toBe("colormap");
    expect(r.defaults.pom).toEqual({
      enabled: false,
      mode: "occlusion",
      scale: 0.04,
      minSteps: 12,
      maxSteps: 40,
      refineSteps: 4,
      shadow: true,
      occlusion: true,
    });
    const messages: Record<string, string> = {
      maxSteps: "max_steps must be <= 100",
      minGtMax: "max_steps must be >= min_steps",
      snowSlope: "snow_slope_max must be in [0, 90]",
      lutMissing: "height_curve_lut is required when height_curve_mode='lut'",
      octaves: "octaves must be in [1, 8]",
      layerCount: "must contain between 1 and 4 layers",
      roughness: "roughness must be in [0.04, 1.0]",
      albedoMode: "must be one of material, colormap, mix",
      tint: "rock_subsurface_tint components must be in [0, 1]",
      fade: "fade_end must be > fade_start",
      heightRange: "height_range: min must be < max",
    };
    for (const [name, message] of Object.entries(messages)) {
      expect(r.invalid[name].code, name).toBe("INVALID_INPUT");
      expect(r.invalid[name].message, name).toContain(message);
    }
    expect(r.sceneRejection.code).toBe("INVALID_INPUT");
    expect(r.defaultReport.enabled).toBe(true);
    expect(r.defaultReport.layerCount).toBe(4);
    expect(r.defaultReport.diagnostics).toEqual([]);
    const codes = r.diagnosticReport.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("terrain-material-texture-invalid");
    expect(codes).toContain("terrain-material-texture-missing");
    expect(codes).toContain("terrain-material-mask-invalid");
    expect(codes).toContain("terrain-material-detail-normal-missing");
    expect(codes).toContain("terrain-material-pom-mode-approximated");
    expect(r.diagnosticReport.texturedLayers).toEqual([true, false, false]);
    expect(r.diagnosticReport.textureWidth).toBe(64);
    expect(r.diagnosticReport.mipLevels).toBe(7);
    expect(r.diagnosticReport.maskChannels).toEqual([]);
    expect(r.plainReport.enabled).toBe(false);
  });

  test("textured layers, masks, detail maps, SSS, spec-AA tiers and debug views", async ({ page }) => {
    test.slow();
    const r = await probe(page, "textured");
    for (const [name, count] of Object.entries<number>(r.nonconstant)) {
      expect(count, `${name} is not a constant frame`).toBeGreaterThan(8);
    }
    for (const [name, delta] of Object.entries<number>(r.deltas)) {
      expect(delta, `${name} changes the frame`).toBeGreaterThan(0.05);
    }
    expect(r.report.texturedLayers).toEqual([true, true, true, true]);
  });

  test("budget downscale, 30-cycle memory return and device-loss replay", async ({ page }) => {
    test.slow();
    const r = await probe(page, "lifecycle");
    expect(r.cycles.peak).toBeGreaterThan(r.cycles.nativeBaseline);
    expect(r.cycles.allReturned).toBe(true);
    expect(r.recovery.status).toBe("ready");
    expect(r.recovery.generations).toBe(2);
    expect(r.recovery.byteEqual).toBe(true);
    expect(r.recovery.reportEqual).toBe(true);
    const codes = r.budget.report.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("terrain-material-texture-downscaled");
    expect(r.budget.report.textureWidth).toBeLessThan(1024);
    expect(r.budget.memory.peakBytes).toBeLessThanOrEqual(r.budget.memory.budgetBytes);
  });

  test("1080p frame time with the full material stack stays within the budget", async ({ page }) => {
    // Two 1080p runtimes with textured layers and IBL; software adapters
    // spend most of this in setup, so allow more than the slow budget.
    test.setTimeout(240_000);
    const r = await probe(page, "performance");
    for (const mode of ["screen", "perspective"]) {
      expect(r[mode].peakBytes).toBeLessThanOrEqual(r[mode].budgetBytes);
      expect(r[mode].report.enabled).toBe(true);
      expect(r[mode].p95).toBeGreaterThan(0);
      // Reference-integrated budget (33.3 ms); the discrete 16.7 ms gate is
      // evidence-bound to the reference-discrete hardware profile. Software
      // (fallback) adapters such as CI's SwiftShader are not a hardware
      // profile: their timings are recorded, not gated.
      if (!r.fallbackAdapter) {
        expect(r[mode].p95).toBeLessThanOrEqual(33.3);
      }
    }
  });
});
