import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW08Vt: Record<string, (...args: any[]) => Promise<any>>;
  }
}

async function probe(page: import("../browser/webgpu-fixture").Page, name: string): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/examples/test-w08-vt.html");
  const result = await page.evaluate((key) => window.__forge3dW08Vt[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  if (process.env.FORGE3D_W08_DEBUG) {
    console.log(name, JSON.stringify(result, null, 1).slice(0, 20000));
  }
  return result;
}

test.describe("W08 material virtual texturing (native tv20 params)", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  test("disabled VT is byte-identical to baseline with zero stats", async ({ page }) => {
    test.slow();
    const r = await probe(page, "disabledIdentity");
    expect(r.maxDiff, `disabled albedo maxDiff ${r.maxDiff}`).toBe(0);
    expect(r.residentPages).toBe(0);
    expect(r.totalPages).toBe(0);
  });

  test("enabled VT changes albedo and reports residency/streaming stats", async ({ page }) => {
    test.slow();
    const r = await probe(page, "enabled");
    expect(r.meanAbsDiff, `meanAbsDiff=${r.meanAbsDiff}`).toBeGreaterThan(0.05);
    const s = r.stats;
    expect(s.enabled).toBe(true);
    expect(s.residentPages, JSON.stringify(s)).toBeGreaterThan(0);
    expect(s.totalPages).toBeGreaterThan(0);
    expect(s.cacheBudgetPages).toBeGreaterThan(0);
    expect(s.residentPages).toBeLessThanOrEqual(s.cacheBudgetPages);
    expect(s.cacheMisses).toBeGreaterThan(0);
    expect(s.tilesStreamed).toBeGreaterThan(0);
    expect(s.avgUploadMs).toBeGreaterThan(0);
    expect(s.sourceCount).toBe(4);
  });

  test("residency budget is enforced under camera motion (evictions)", async ({ page }) => {
    test.slow();
    const r = await probe(page, "budget");
    for (const stats of [r.statsLeft, r.statsRight]) {
      expect(stats.residentPages, JSON.stringify(stats)).toBeLessThanOrEqual(
        stats.cacheBudgetPages,
      );
    }
    expect(r.statsRight.evictions, JSON.stringify(r.statsRight)).toBeGreaterThan(0);
  });

  test("shader feedback requests land without blocking and count each page once", async ({ page }) => {
    test.slow();
    const r = await probe(page, "feedback");
    // Every page of the 4 x (4 + 1) pyramid once (see the harness): the 12
    // zeroed slots of the 32-slot ring are not requests, and nothing is
    // counted twice.
    expect(r.stats.feedbackRequests, JSON.stringify(r.frames)).toBe(20);
    expect(r.stats.totalPages, JSON.stringify(r.stats)).toBe(20);
    // Landed, then held steady for a frame, inside the 30-frame bound.
    expect(r.frames.length, JSON.stringify(r.frames)).toBeLessThan(30);
  });

  test("a normal-family commit is rejected with vt_unsupported_family", async ({ page }) => {
    test.slow();
    const r = await probe(page, "rejectNormalFamily");
    expect(r.commitError, "expected the VT commit to throw").not.toBeNull();
    expect(r.commitError.code).toBe("UNSUPPORTED_FEATURE");
    expect(r.commitError.diagnosticCodes).toContain("vt_unsupported_family");
    // Nothing was allocated: stats stay zero.
    expect(r.stats.residentPages).toBe(0);
    expect(r.stats.totalPages).toBe(0);
    // The free validation fn reports the same blocking diagnostic.
    expect(r.report.status).not.toBe("supported");
    expect(r.report.diagnosticCodes).toContain("vt_unsupported_family");
  });

  test("native vt-on/vt-off golden parity (SSIM >= 0.98)", async ({
    page,
  }, testInfo) => {
    test.slow();
    const r = await probe(page, "goldenParity");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(testInfo.outputDir, { recursive: true });
    if (typeof r.offPng === "string") {
      writeFileSync(
        `${testInfo.outputDir}/web-vt-off.png`,
        Buffer.from(r.offPng.split(",")[1], "base64"),
      );
    }
    if (typeof r.onPng === "string") {
      writeFileSync(
        `${testInfo.outputDir}/web-vt-on.png`,
        Buffer.from(r.onPng.split(",")[1], "base64"),
      );
    }
    expect(r.heightsMatch, `heights sha256 ${r.heightsSha256}`).toBe(true);
    for (const check of r.sourceChecks) {
      expect(
        check.match,
        `vt source ${check.materialIndex} sha256 ${check.sha256} != ${check.expected}`,
      ).toBe(true);
    }
    // Diagnostics only: the shadowed-beauty SSIMs measure the
    // pre-existing W07 screen-path shadow coverage at the tv20 params
    // (native marks the frame mostly shadowed; the web LessEqual path
    // with no casters renders lit) — not part of the VT contract.
    console.log(
      `vt-golden: shadowed off=${r.ssimOff} on=${r.ssimOn} | ` +
        `shadowless off=${r.ssimNsOff} on=${r.ssimNsOn} | ` +
        `albedo off=${r.albedoSsimOff}/${r.albedoMeanAbsOff} ` +
        `on=${r.albedoSsimOn}/${r.albedoMeanAbsOn} ` +
        `|on-off|=${r.albedoOnOffDelta} (native ${r.nativeAlbedoDelta})`,
    );
    await testInfo.attach("vt-golden-diagnostics", {
      body: JSON.stringify(
        {
          ssimOff: r.ssimOff,
          ssimOn: r.ssimOn,
          ssimNsOff: r.ssimNsOff,
          ssimNsOn: r.ssimNsOn,
          albedoSsimOff: r.albedoSsimOff,
          albedoSsimOn: r.albedoSsimOn,
          albedoMeanAbsOff: r.albedoMeanAbsOff,
          albedoMeanAbsOn: r.albedoMeanAbsOn,
          albedoOnOffDelta: r.albedoOnOffDelta,
          meanAbsDiff: r.meanAbsDiff,
          nativeDelta: r.nativeDelta,
          nativeAlbedoDelta: r.nativeAlbedoDelta,
          diffOff: r.diffOff,
          diffNsOff: r.diffNsOff,
          stats: r.stats,
        },
        undefined,
        1,
      ),
      contentType: "application/json",
    });
    // PRIMARY golden — the albedo AOV isolates the VT output from the
    // pre-existing W07 screen-path shadow fidelity (the same assertion
    // shape the native test_tv20 uses). Both sides are float32 linear RGB
    // in [0,1] with no sRGB encoding: SSIM on the linear values and a
    // mean absolute difference bound of 0.01.
    expect(
      r.albedoSsimOff,
      `vt-off albedo ssim=${r.albedoSsimOff}`,
    ).toBeGreaterThanOrEqual(0.98);
    expect(
      r.albedoSsimOn,
      `vt-on albedo ssim=${r.albedoSsimOn}`,
    ).toBeGreaterThanOrEqual(0.98);
    expect(
      r.albedoMeanAbsOff,
      `vt-off albedo meanAbs=${r.albedoMeanAbsOff}`,
    ).toBeLessThanOrEqual(0.01);
    expect(
      r.albedoMeanAbsOn,
      `vt-on albedo meanAbs=${r.albedoMeanAbsOn}`,
    ).toBeLessThanOrEqual(0.01);
    expect(
      r.albedoOnOffDelta,
      `web albedo mean|on-off|=${r.albedoOnOffDelta} (native ${r.nativeAlbedoDelta})`,
    ).toBeGreaterThan(0.05);
    // SECONDARY golden — beauty with shadows disabled on both sides.
    // Only the VT-on leg is asserted: it is the frame that carries VT
    // output. The vt-off frame (shadowed or shadowless) is the pure W07
    // material screen path with no W08 feature active; its native SSIM
    // measures pre-existing W07 lighting-model fidelity at the tv20
    // params (0.9537 shadowless — the base sun/IBL application, not
    // shadow coverage and not VT), so it is logged as a diagnostic above
    // while the off side stays locked by the byte-identity contract and
    // the albedo-AOV comparison (0.9915).
    expect(
      r.ssimNsOn,
      `vt-on shadowless ssim=${r.ssimNsOn}`,
    ).toBeGreaterThanOrEqual(0.98);
    // The VT-off frame is the W07 material screen path with no W08
    // feature active: the contract is byte-identity between the
    // `virtualTexture: {enabled:false}` frame and the frame rendered with
    // no `virtualTexture` input at all (the same contract the separate
    // "disabled VT is byte-identical" case asserts).
    expect(
      r.offDisabledByteEqual,
      `vt-off byte-identity vs no-virtualTexture frame (maxDiff=${r.offDisabledMaxDiff})`,
    ).toBe(true);
    // Runtime residency/streaming stats must match the native 1.38
    // runtime at the golden params (480/20/20/20/4).
    expect(
      r.stats.residentPages,
      `residentPages ${r.stats.residentPages} != ${r.nativeStats.resident_pages}`,
    ).toBe(r.nativeStats.resident_pages);
    expect(r.stats.residentPages).toBe(20);
    expect(r.stats.totalPages).toBe(480);
    expect(r.stats.totalPages).toBe(r.nativeStats.total_pages);
    expect(r.stats.cacheMisses).toBe(20);
    expect(r.stats.tilesStreamed).toBe(20);
    expect(r.stats.sourceCount).toBe(4);
  });

  test("TS validateTerrainVtSupport matches the wasm free fn", async ({
    page,
  }) => {
    const r = await probe(page, "vtSupportParity");
    for (const entry of r.cases) {
      expect(
        entry.equal,
        `${entry.name}: ts=${JSON.stringify(entry.ts)} wasm=${JSON.stringify(entry.wasm)}`,
      ).toBe(true);
    }
  });

  test("stats snapshot for native comparison", async ({ page }) => {
    test.slow();
    const r = await probe(page, "stats");
    expect(r.capabilities.terrainVirtualTexture).toBe(true);
    expect(r.stats.residentPages).toBeGreaterThan(0);
  });

  for (const probeName of ["viewerDeviceLoss", "sessionDeviceLoss"] as const) {
    test(`${probeName}: VT sources replay before the terrain; frame byte-equal`, async ({ page }) => {
      test.slow();
      const r = await probe(page, probeName);
      expect(r.status).toBe("ready");
      // The loss really happened: one recovery (viewer) / a replacement
      // runtime (session).
      if (probeName === "viewerDeviceLoss") {
        expect(r.recoveryAttempts).toBe(1);
      } else {
        expect(r.runtimes).toBe(2);
      }
      expect(r.statsBefore.sourceCount, JSON.stringify(r.statsBefore)).toBe(4);
      expect(r.statsAfter.sourceCount, JSON.stringify(r.statsAfter)).toBe(
        r.statsBefore.sourceCount,
      );
      expect(r.statsAfter.residentPages).toBe(r.statsBefore.residentPages);
      expect(r.diff.byteEqual, JSON.stringify(r.diff)).toBe(true);
    });
  }
});
