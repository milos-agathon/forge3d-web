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

// Expected per feature for each device cap: null = commit succeeds.
const GATES: Array<{
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

  for (const gate of GATES) {
    test(`maxSampledTexturesPerShaderStage ${gate.cap}: capabilities and typed UNSUPPORTED_FEATURE`, async ({ page }) => {
      test.slow();
      await page.addInitScript(capSampledTextures(gate.cap));
      const r = await probe(page, "limitGates");
      expect(r.caps.maxSampledTexturesPerShaderStage, JSON.stringify(r.caps)).toBe(gate.cap);
      expect(r.caps.terrainClipmap).toBe(true);
      expect(r.clipmap, JSON.stringify(r.clipmap)).toBeNull();
      expect(r.caps.terrainStreaming).toBe(gate.streaming);
      expect(r.caps.terrainOverlays).toBe(gate.overlays);
      expect(r.caps.terrainVirtualTexture).toBe(gate.vt);
      for (const feature of ["streaming", "overlays", "vt"] as const) {
        if (gate[feature]) {
          expect(r[feature], `${feature} at cap ${gate.cap}: ${JSON.stringify(r[feature])}`).toBeNull();
        } else {
          expect(r[feature], `${feature} at cap ${gate.cap}`).toMatchObject(UNSUPPORTED);
          expect(r[feature].message).toContain(`device has ${gate.cap}`);
        }
      }
    });
  }

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
