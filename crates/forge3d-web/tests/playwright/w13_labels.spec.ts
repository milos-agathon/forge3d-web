import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";
declare global {
  interface Window {
    __w13: Record<string, () => Promise<any>>;
  }
}
for (const dist of [false, true]) {
  test(`W13 actual labels, capture, resize, deterministic replay and release (${dist ? "dist" : "source"})`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/examples/test-w13-labels.html" + (dist ? "?dist" : ""));
    await page.waitForFunction(() => !!window.__w13);
    const r = await page.evaluate(() => window.__w13.render!());
    expect(r.covered).toBeGreaterThan(3000);
    expect(r.glyphCount).toBeGreaterThan(10);
    expect(r.accepted).toHaveLength(4);
    expect(r.deterministic).toBe(true);
    expect(r.replay).toBe(true);
    expect(r.resizeRoundTrip).toBe(true);
    expect(r.resizedCovered).toBeGreaterThan(3000);
    expect(r.captureCovered).toBeGreaterThan(3000);
    expect(r.captureDiff.max).toBeLessThanOrEqual(1);
    expect(r.clearMatches).toBe(true);
    expect(
      r.before.categories.buffers - r.after.categories.buffers,
    ).toBeGreaterThanOrEqual(r.bytes);
    expect(r.after.categories["render-bundles"]).toBe(0);
    expect(errors).toEqual([]);
  });
}
for (const name of ["outline", "depth", "session", "viewer", "contracts"])
  test(`W13 ${name}`, async ({ page, webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await page.goto("/examples/test-w13-labels.html");
    await page.waitForFunction(() => !!window.__w13);
    const r = await page.evaluate((name) => window.__w13[name]!(), name);
    if (name === "outline") {
      expect(r.agreement).toBeGreaterThan(0.98);
      expect(r.covered).toBeGreaterThan(3000);
      expect(r.expectedCovered).toBeGreaterThan(3000);
      expect(r.holes).toBeGreaterThan(500);
      expect(r.negativeControlAgreement).toBeLessThan(0.9);
    }
    if (name === "depth") {
      expect(r.visible).toBeGreaterThan(500);
      expect(r.hidden).toBe(0);
      expect(r.capture).toBe(0);
    }
    if (name === "session") {
      expect(r.before).toBeGreaterThan(1000);
      expect(r.disabled).toBe(0);
      expect(r.copiedNodes).toBeGreaterThan(0);
    }
    if (name === "viewer") {
      expect(r.before).toBeGreaterThan(500);
      expect(r.disabled).toBe(0);
      expect(r.resized).toBeGreaterThan(500);
      expect(r.recovered).toBeGreaterThan(500);
      expect(r.accepted).toEqual([1]);
      expect(r.viewerDisposed).toBe(true);
      expect(r.fontStillAlive).toBe(true);
    }
    if (name === "contracts") {
      expect(r.glyphCount).toBeGreaterThan(4);
      expect(r.nodes).toBeGreaterThan(1);
      expect(r.curved).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: "experimental_feature",
            support_level: "experimental",
            details: { feature: "curved labels" },
          },
        ],
      });
      expect(r.elevated.diagnostics[0].details.feature).toBe(
        "terrain-elevated line labels",
      );
      expect(r.terrain).toEqual([20, 30, 42]);
      expect(r.serialized).toBe(true);
      expect(r.fonts).toEqual([
        "NotoSans",
        "NotoSansArabic",
        "NotoSansDevanagari",
      ]);
    }
  });
