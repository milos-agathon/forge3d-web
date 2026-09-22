import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW03Probe: () => Promise<any>;
  }
}

test("W03 terrain dataset sources, analysis, readback, and debug views", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/examples/test-w03-terrain.html");
  const result = await page.evaluate(() => window.__forge3dW03Probe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  for (const mode of ["direct", "file", "url"] as const) {
    expect(result.sources[mode].maxError).toBeLessThanOrEqual(1e-6);
    expect(result.sources[mode].nanMismatch).toBe(0);
  }
  expect(result.sources.progressDone).toBe(true);
  for (const stats of [
    result.sources.fileStatistics,
    result.sources.urlStatistics,
  ]) {
    expect(stats.count).toBe(257 * 257 - 2);
    expect(stats.nodataCount).toBe(2);
  }

  expect(result.statistics.count).toBe(257 * 257 - 2);
  expect(result.statistics.nodataCount).toBe(2);
  expect(result.estimatedCpuBytes).toBeLessThanOrEqual(67_108_864);

  expect(result.query.centerIsNodata).toBe(true);
  expect(result.query.gridResult).not.toBeNull();
  const gridResult = result.query.gridResult;
  const gridAbs = Math.abs(gridResult.elevation - gridResult.expected);
  const gridRel = gridAbs / Math.max(Math.abs(gridResult.expected), 1e-30);
  expect(Math.min(gridAbs, gridRel)).toBeLessThanOrEqual(1e-6);
  expect(gridResult.slopeRadians).toBeGreaterThan(0);
  expect(gridResult.aspectRadians).toBeGreaterThanOrEqual(0);
  expect(gridResult.aspectRadians).toBeLessThan(Math.PI * 2);
  expect(gridResult.normalLength).toBeCloseTo(1, 5);

  expect(result.demReadback.maxError).toBeLessThanOrEqual(1e-6);
  expect(result.demReadback.nanMismatch).toBe(0);

  expect(result.slopeAspect.width).toBe(257);
  expect(result.slopeAspect.height).toBe(257);
  expect(result.slopeAspect.nanMismatch).toBe(0);
  expect(result.slopeAspect.maxSlopeError).toBeLessThanOrEqual(1e-4);
  expect(result.slopeAspect.maxAspectError).toBeLessThanOrEqual(1e-4);

  expect(result.contours.polylineCount).toBeGreaterThan(0);
  expect(result.contours.vertexMaxCells).toBeLessThanOrEqual(0.25);
  expect(result.contours.hausdorffCells).toBeLessThanOrEqual(0.25);
  expect(result.demContour.polylineCount).toBeGreaterThan(0);

  expect(result.cpuFields.aoMin).toBeLessThan(0.98);
  expect(result.cpuFields.sunMin).toBeLessThan(0.98);

  expect(result.gpuParity.aoKind).toBe("height-ao");
  expect(result.gpuParity.sunKind).toBe("sun-visibility");
  expect(result.gpuParity.aoWidth).toBe(65);
  expect(result.gpuParity.sunWidth).toBe(65);
  expect(result.gpuParity.ao.maxError).toBeLessThanOrEqual(0.02);
  expect(result.gpuParity.ao.nanMismatch).toBe(0);
  expect(result.gpuParity.sun.maxError).toBeLessThanOrEqual(0.02);
  expect(result.gpuParity.sun.nanMismatch).toBe(0);

  expect(result.disabledAoCode).toBe("UNSUPPORTED_FEATURE");
  expect(result.disabledSunCode).toBe("UNSUPPORTED_FEATURE");

  expect(result.resident.aoKind).toBe("height-ao");
  expect(result.resident.sunKind).toBe("sun-visibility");
  expect(result.resident.ao.maxError).toBeLessThanOrEqual(0.02);
  expect(result.resident.ao.nanMismatch).toBe(0);
  expect(result.resident.sun.maxError).toBeLessThanOrEqual(0.02);
  expect(result.resident.sun.nanMismatch).toBe(0);

  expect(result.renderDiffers).toBe(true);

  for (const debug of [result.debugAo, result.debugSun]) {
    expect(debug.grayscale).toBe(true);
    expect(debug.nonconstant).toBe(true);
    expect(debug.nonzeroAlpha).toBeGreaterThan(0);
  }

  expect(result.disabledCompute.aoAllOne).toBe(true);
  expect(result.disabledCompute.sunAllOne).toBe(true);
  expect(result.disabledCompute.aoMaxError).toBe(0);
  expect(result.disabledCompute.sunMaxError).toBe(0);

  expect(result.ledger.afterSuccess).toBe(true);
  expect(result.ledger.afterError).toBe(true);
  expect(result.ledger.rejectedCode).toBe("INVALID_INPUT");

  expect(result.sourcePath.ao.maxError).toBeLessThanOrEqual(0.02);
  expect(result.sourcePath.ao.nanMismatch).toBe(0);
  expect(result.sourcePath.sun.maxError).toBeLessThanOrEqual(0.02);
  expect(result.sourcePath.sun.nanMismatch).toBe(0);
  expect(result.sourcePath.render.grayscale).toBe(true);
  expect(result.sourcePath.render.nonconstant).toBe(true);
  expect(result.sourcePath.render.nonzeroAlpha).toBeGreaterThan(0);

  expect(result.memory.increase).toBeLessThanOrEqual(134_217_728);
  expect(result.memory.increase).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
