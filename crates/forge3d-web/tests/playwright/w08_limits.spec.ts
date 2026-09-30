import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

// W08 (E0) limit gates and typed resource errors. The gate tests lower the
// adapter's reported maxSampledTexturesPerShaderStage before the runtime
// requests its device (wgpu asks for min(adapter, 24)), so the device is
// created with exactly 16 / 17 / 18 sampled textures per stage.

declare global {
  interface Window {
    __forge3dW08: Record<string, (...args: any[]) => Promise<any>>;
  }
}

async function probe(page: import("../browser/webgpu-fixture").Page, name: string): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/examples/test-w08-terrain.html");
  const result = await page.evaluate((key) => window.__forge3dW08[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  if (process.env.FORGE3D_W08_DEBUG) {
    console.log(name, JSON.stringify(result, null, 1).slice(0, 20000));
  }
  return result;
}

function capSampledTextures(cap: number): () => void {
  // Serialized into the page by addInitScript.
  return new Function(`
    const cap = ${cap};
    if (typeof GPU === "undefined") return;
    const original = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = async function (...args) {
      const adapter = await original.apply(this, args);
      if (adapter === null) return adapter;
      const real = adapter.limits;
      const limits = {};
      for (const key in real) limits[key] = real[key];
      limits.maxSampledTexturesPerShaderStage = Math.min(
        cap,
        real.maxSampledTexturesPerShaderStage,
      );
      Object.defineProperty(adapter, "limits", { value: limits, configurable: true });
      return adapter;
    };
  `) as () => void;
}

const UNSUPPORTED = { code: "UNSUPPORTED_FEATURE" };

// Textured material 0 (the textured pipeline profile binds the five scene
// TextureSet textures): expected per feature for each device cap.
const TEXTURED_GATES: Array<{
  cap: number;
  streaming: boolean;
  overlays: boolean;
  vt: boolean;
}> = [
  { cap: 16, streaming: false, overlays: false, vt: false },
  { cap: 17, streaming: true, overlays: false, vt: false },
  { cap: 18, streaming: true, overlays: true, vt: false },
];

test.describe("W08 limit gates and typed resource errors", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  for (const { cap } of TEXTURED_GATES) {
    test(`maxSampledTexturesPerShaderStage ${cap}: untextured terrain gets every W08 feature`, async ({ page }) => {
      test.slow();
      await page.addInitScript(capSampledTextures(cap));
      const r = await probe(page, "limitGates");
      expect(r.caps.maxSampledTexturesPerShaderStage, JSON.stringify(r.caps)).toBe(cap);
      for (const flag of [
        "terrainClipmap",
        "terrainStreaming",
        "terrainOverlays",
        "terrainVirtualTexture",
      ] as const) {
        expect(r.caps[flag], flag).toBe(true);
      }
      for (const feature of ["clipmap", "streaming", "overlays", "vt"] as const) {
        expect(r[feature], `${feature} at cap ${cap}: ${JSON.stringify(r[feature])}`).toBeNull();
      }
    });
  }

  for (const gate of TEXTURED_GATES) {
    test(`maxSampledTexturesPerShaderStage ${gate.cap}: textured material 0 gates W08 with typed UNSUPPORTED_FEATURE`, async ({ page }) => {
      test.slow();
      await page.addInitScript(capSampledTextures(gate.cap));
      const r = await probe(page, "limitGatesTextured");
      expect(r.sampled).toBe(gate.cap);
      expect(r.texturedCommit, JSON.stringify(r.texturedCommit)).toBeNull();
      expect(r.attempts.clipmap, JSON.stringify(r.attempts.clipmap)).toBeNull();
      expect(r.renders.clipmap).toBeGreaterThan(0);
      for (const feature of ["streaming", "overlays", "vt"] as const) {
        if (gate[feature]) {
          expect(r.attempts[feature], `${feature}: ${JSON.stringify(r.attempts[feature])}`).toBeNull();
          expect(r.renders[feature], `${feature} render`).toBeGreaterThan(0);
        } else {
          expect(r.attempts[feature], feature).toMatchObject(UNSUPPORTED);
          expect(r.attempts[feature].message).toContain(`device has ${gate.cap}`);
          expect(r.attempts[feature].message).toContain("terrain material 0 is textured");
        }
      }
      // Reverse order: overlays committed untextured always fit; texturing
      // material 0 afterwards is refused atomically where it cannot fit.
      expect(r.overlaysUntextured, JSON.stringify(r.overlaysUntextured)).toBeNull();
      if (gate.overlays) {
        expect(r.reverseMaterial, JSON.stringify(r.reverseMaterial)).toBeNull();
      } else {
        expect(r.reverseMaterial).toMatchObject(UNSUPPORTED);
        expect(r.reverseMaterial.message).toContain("terrain overlays");
        expect(r.reverseLedgerEqual).toBe(true);
        expect(r.reverseFrame.byteEqual, JSON.stringify(r.reverseFrame)).toBe(true);
      }
    });
  }

  test("textured material 0 with every W08 feature renders when the device allows it", async ({ page }) => {
    test.slow();
    const r = await probe(page, "limitGatesTextured");
    test.skip(r.sampled < 19, `adapter exposes ${r.sampled} sampled textures (< 19)`);
    expect(r.texturedCommit).toBeNull();
    for (const feature of ["clipmap", "streaming", "overlays", "vt"] as const) {
      expect(r.attempts[feature], `${feature}: ${JSON.stringify(r.attempts[feature])}`).toBeNull();
      expect(r.renders[feature], `${feature} render`).toBeGreaterThan(0);
    }
    expect(r.reverseMaterial).toBeNull();
  });

  test("atlases beyond maxTextureDimension2D are RESOURCE_LIMIT_EXCEEDED and change nothing", async ({ page }) => {
    test.slow();
    const r = await probe(page, "atlasDimensionLimits");
    expect(r.streamingError, JSON.stringify(r.streamingError)).toMatchObject({
      code: "RESOURCE_LIMIT_EXCEEDED",
    });
    expect(r.streamingError.message).toContain(`maxTextureDimension2D ${r.max}`);
    expect(r.vtError, JSON.stringify(r.vtError)).toMatchObject({
      code: "RESOURCE_LIMIT_EXCEEDED",
    });
    expect(r.vtError.message).toContain(`maxTextureDimension2D ${r.max}`);
    expect(r.ledgerAfter).toEqual(r.ledgerBefore);
    expect(r.frame.byteEqual, JSON.stringify(r.frame)).toBe(true);
  });

  test("W08 allocations are pre-checked: a rejected commit leaves ledger and terrain untouched", async ({ page }) => {
    test.slow();
    const r = await probe(page, "w08MemoryPrecheck");
    for (const key of ["streamingError", "vtError"] as const) {
      expect(r[key], `${key}: ${JSON.stringify(r[key])}`).toMatchObject({
        code: "RESOURCE_LIMIT_EXCEEDED",
      });
    }
    expect(r.ledgerAfterStreaming).toEqual(r.ledgerBefore);
    expect(r.ledgerAfter).toEqual(r.ledgerBefore);
    expect(r.frame.byteEqual, JSON.stringify(r.frame)).toBe(true);
  });
});
