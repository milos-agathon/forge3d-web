import {
  test,
  expect,
  skipRenderAssertionsWhenProbing,
} from "../browser/webgpu-fixture";
import { captureW16Soak, validateW16HostState } from '../../scripts/w16-host-state.mjs';
declare global {
  interface Window {
    __w16: any;
  }
}
for (const dist of [false, true]) {
  const mode = dist ? "dist" : "source",
    open = async (page: any) => {
      await page.goto(
        "/examples/pointcloud-tiles.html" + (dist ? "?dist" : ""),
      );
      await page.waitForFunction(() => !!window.__w16);
    };
  test(`W16 ${mode}: independent LAZ/COPC/EPT counts, positions, colors and W15 b3dm`, async ({
    page,
  }) => {
    await open(page);
    const r = await page.evaluate(() => window.__w16.io());
    expect(r.laz.count).toBe(r.manifest.autzen.count);
    expect(r.laz.positions).toBe(r.manifest.autzen.positionsSha256);
    expect(r.laz.colors).toBe(r.manifest.autzen.colorsSha256);
    expect(r.copc.rootCount).toBe(r.manifest.copcRoot.count);
    expect(r.copc.rootPositions).toBe(r.manifest.copcRoot.positionsSha256);
    expect(r.copc.rootColors).toBe(r.manifest.copcRoot.colorsSha256);
    expect(r.copc.count).toBe(r.manifest.copc.count);
    expect(r.copc.pointsRead).toBe(r.manifest.copc.count);
    expect(r.copc.chunks).toBeGreaterThan(1);
    expect(r.copc.positions).toBe(r.manifest.copc.positionsSha256);
    expect(r.copc.colors).toBe(r.manifest.copc.colorsSha256);
    expect(r.copc.metadata.center).toEqual(r.manifest.copcInfo.center);
    expect(
      r.copc.requests.every((x: any) => x.status === 206 && x.range !== null),
    ).toBe(true);
    expect(r.ept.count).toBe(r.manifest.ept.count);
    expect(r.ept.positions).toBe(r.manifest.ept.positionsSha256);
    expect(r.ept.colors).toBe(r.manifest.ept.colorsSha256);
    expect(r.tiles.stats.pointCount).toBe(3);
    expect(r.tiles.stats.triangles).toBe(1);
    expect(r.tiles.external).toBe(1);
    expect(r.tiles.mesh.slice(0, 3)).toEqual([4, 5, 6]);
    expect(r.worker.mode).toBe("transferable");
  });
  test(`W16 ${mode}: initial view uses <=25% ranged bytes and typed failures`, async ({
    page,
  }) => {
    await open(page);
    const r = await page.evaluate(() => window.__w16.ranged());
    expect(r.points).toBeGreaterThan(0);
    expect(r.points).toBeLessThanOrEqual(5000);
    expect(r.keys).toContain("0-0-0-0");
    expect(r.rootPositions).toBe(r.expected.root.positionsSha256);
    expect(r.rootColors).toBe(r.expected.root.colorsSha256);
    expect(r.expected.root.bounds).toEqual(r.expected.bounds);
    expect(r.coveredPixels).toBeGreaterThan(150);
    expect(r.negativeKeys).toEqual([]);
    expect(r.negativeCoveredPixels).toBe(0);
    expect(r.fraction).toBeLessThanOrEqual(0.25);
    expect(
      r.requests.every((x: any) => x.range !== null && x.status === 206),
    ).toBe(true);
    const f = await page.evaluate(() => window.__w16.failures());
    expect(f.range).toEqual({
      code: "IO_ERROR",
      reason: "range-not-supported",
    });
    expect(f.cancel.code).toBe("REQUEST_CANCELLED");
    expect(f.budget.code).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(f.corrupt.code).toBe("INVALID_INPUT");
  });
  test(`W16 ${mode}: covered point colors, aligned GPU picking, resize, recovery and allocation cycles`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await page.addInitScript(() => {
      const gpu = navigator.gpu,
        request = gpu.requestAdapter.bind(gpu);
      gpu.requestAdapter = async (options) => {
        const adapter = await request(options);
        if (adapter) {
          const requestDevice = adapter.requestDevice.bind(adapter);
          adapter.requestDevice = async (options) => {
            const device = await requestDevice(options);
            (window as any).__loseW16Device = () => device.destroy();
            return device;
          };
        }
        return adapter;
      };
    });
    await open(page);
    const r = await page.evaluate(() => window.__w16.rendering());
    expect(r.lost).toBe(true);
    expect(r.styles).toEqual({
      rgb: [0, 255, 0],
      elevation: [0, 0, 255],
      intensity: r.styles.intensity,
      classification: [51, 102, 153],
    });
    expect(
      r.styles.intensity.every((x: number) => Math.abs(x - 128) <= 1),
    ).toBe(true);
    expect(new Set(r.styles.intensity).size).toBe(1);
    expect(r.pressure.code).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.pressure.before).toBe(r.pressure.after);
    expect(r.pressure.before).toBe(r.pressure.recovered);
    expect(r.pressure.pick.pointIndex).toBe(1);
    expect(r.pressure.bytes).toBe(r.pressure.baseline);
    expect(r.pressure.peak).toBeLessThanOrEqual(r.pressure.budget);
    expect(r.counts.red).toBeGreaterThan(150);
    expect(r.counts.green).toBeGreaterThan(150);
    expect(r.counts.blue).toBeGreaterThan(150);
    expect(r.picks.map((p: any) => p.pointIndex)).toEqual([0, 1, 2]);
    expect(r.picks.map((p: any) => p.color.slice(0, 3))).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ]);
    expect(r.before).toBe(r.after);
    expect(r.stable.gpuBytes).toBe(r.base.gpuBytes);
    expect(r.stable.bufferCreations).toBe(r.base.bufferCreations + 1);
    expect(r.resized).toBe(320 * 240 * 4);
    expect(r.cleared.pointsRendered).toBe(0);
    expect(r.disposed.gpuBytes).toBe(0);
    expect(r.stable.peakGpuBytes).toBeLessThanOrEqual(
      r.stable.memoryBudgetBytes,
    );
  });
  test(`W16 ${mode}: branching native REPLACE and independent ADD/frustum cameras, B3DM integration`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    test.setTimeout(180000);
    await open(page);
    const r = await page.evaluate(() => window.__w16.workload());
    const tiles = await page.evaluate(() => window.__w16.tileReferences());
    expect(tiles.actual).toEqual(tiles.expected);
    expect(tiles.coverage.records).toBe(256);
    expect(tiles.coverage.uniqueSelections).toBeGreaterThanOrEqual(20);
    expect(r.count).toBe(1000000);
    expect(r.layerCameras).toBe(64);
    expect(r.cullingDifferences).toBe(64);
    expect(r.manifest.workloadEpt.topology.branchNodes).toBeGreaterThan(400);
    expect(
      r.manifest.workloadEpt.selectionCoverage.uniqueAdditiveSets,
    ).toBeGreaterThanOrEqual(32);
    expect(r.cameras).toEqual(
      r.manifest.cameraSelections
        .filter((x: any) => x.source === "workload-ept")
        .map((x: any) => x.nodes),
    );
    for (let i = 0; i < r.nodes.length; i++) {
      expect(r.nodes[i].positions).toBe(
        r.manifest.workloadEpt.nodes[i].positionsSha256,
      );
      expect(r.nodes[i].colors).toBe(
        r.manifest.workloadEpt.nodes[i].colorsSha256,
      );
    }
    const mesh = await page.evaluate(() => window.__w16.meshRendering());
    expect(mesh.covered).toBeGreaterThan(100);
    expect(mesh.negative).toBe(0);
    expect(mesh.triangles).toBe(1);
  });
}
test("W16 10-minute real-data camera traversal retains budget and records adapter", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  test.skip(
    process.env.FORGE3D_W16_SOAK !== "1",
    "Run the explicit 10-minute W16 acceptance command",
  );
  test.setTimeout(700000);
  await page.goto("/examples/pointcloud-tiles.html?dist");
  await page.waitForFunction(() => !!window.__w16);
  const target = process.env.FORGE3D_W16_PROFILE ?? "reference-discrete";
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('test-results', { recursive: true });
  let result;
  try {
    result = await captureW16Soak(() => page.evaluate(
      (target) => window.__w16.soak(600000, target), target),
      { binding: { kind: 'local-playwright', targetProfile: target } });
  } catch (error: any) {
    writeFileSync('test-results/w16-soak.json', JSON.stringify(error.w16Observation, null, 2) + '\n');
    throw error;
  }
  // Persist the observation before assertions so a failing acceptance run
  // leaves its measured p95, adapter and allocations available for review.
  writeFileSync('test-results/w16-soak.json', JSON.stringify(result, null, 2) + '\n');
  validateW16HostState(result.hostState, { durationMs: result.durationMs });
  expect(result.durationMs).toBeGreaterThanOrEqual(600000);
  expect(result.frames).toBeGreaterThan(1000);
  expect(result.selectionCount).toBeGreaterThanOrEqual(32);
  expect(result.keyframesVisited).toBe(64);
  expect(result.coveredPixels).toBeGreaterThan(150);
  expect(result.minPoints).toBeLessThan(result.maxPoints);
  expect(result.maxPoints).toBeLessThanOrEqual(300000);
  expect(result.maxCpuBytes).toBeLessThanOrEqual(result.budgets.cpuBudgetBytes);
  expect(result.stats.peakGpuBytes).toBeLessThanOrEqual(
    result.budgets.gpuBudgetBytes,
  );
  expect(result.disposed.gpuBytes).toBe(0);
  expect(result.stats.peakGpuBytes).toBeLessThanOrEqual(
    result.stats.memoryBudgetBytes,
  );
  expect(result.frameP95Ms).toBeLessThanOrEqual(result.budgets.p95Ms);
});
