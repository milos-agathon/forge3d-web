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
  test(`W16 ${mode}: abort and deadline terminate stuck WASM workers, then decode real LAZ`, async ({ page }) => {
    await open(page);
    const result = await page.evaluate(async (dist) => {
      const api = await (dist ? import("/dist/index.js") : import("/src-ts/index.ts"));
      const bytes = new Uint8Array(await (await fetch("/tests/fixtures/w16/autzen_trim.laz")).arrayBuffer());
      const manifest = await (await fetch("/tests/fixtures/w16/copc-ept-tiles-v1.json")).json();
      const hash = async (array: ArrayBufferView) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
        array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength) as ArrayBuffer))]
        .map((x) => x.toString(16).padStart(2, "0")).join("");
      const runs = [];
      for (const reason of ["abort", "deadline"]) {
        let created = 0, terminated = 0, entered!: () => void, startupFailed!: (error: Error) => void;
        const stuck = new Promise<void>((resolve, reject) => { entered = resolve; startupFailed = reject; });
        const pool = new api.Forge3DWorkerPool({
          size: 1, jobTimeoutMs: 10_000,
          mainThreadHandler: api.createPointCloudWorkerHandler(),
          workerFactory: () => {
            created += 1;
            const worker = new Worker("/examples/test-w16-stuck-worker.js" + (dist ? "?dist" : ""), { type: "module" });
            worker.addEventListener("message", ({ data }) => {
              if (data.state === "stuck-wasm-entered") entered();
            });
            worker.addEventListener("error", (event) => startupFailed(new Error(
              `Stuck-WASM worker failed to start: ${event.message}`,
            )));
            worker.addEventListener("messageerror", () => startupFailed(new Error(
              "Stuck-WASM worker could not deserialize its startup message",
            )));
            const channel = new MessageChannel();
            worker.postMessage({ port: channel.port2 }, [channel.port2]);
            return { port: channel.port1, terminate: () => { terminated += 1; worker.terminate(); } };
          },
        });
        try {
          const controller = new AbortController(), start = performance.now();
          const failure = pool.run({ kind: "test-stuck-wasm" }, {
            signal: controller.signal, timeoutMs: reason === "deadline" ? 1500 : 10_000,
            requireHardStop: true,
          }).then(() => ({ code: "unexpected-success" }), (error) => ({ code: error.code, message: error.message, details: error.details }));
          await Promise.race([stuck, failure.then((error) => {
            throw new Error(`Stuck-WASM entry was not observed before the bounded job ended: ${JSON.stringify(error)}`);
          })]);
          // The recovery job is already waiting when the stuck worker is killed.
          const recovered = pool.run({ kind: "laz-file", bytes }, { requireHardStop: true });
          if (reason === "abort") controller.abort();
          const error = await failure, elapsedMs = performance.now() - start;
          const data = await recovered;
          runs.push({ reason, error, elapsedMs, created, terminated,
            positions: await hash(data.positions), colors: await hash(data.colors),
            count: data.positions.length / 3, diagnostics: pool.getDiagnostics() });
        } finally { pool.dispose(); }
      }
      // Public direct calls use their own terminable worker, too.
      const direct = await api.decodeLaz(bytes, { timeoutMs: 10_000 });
      return { runs, expected: manifest.autzen,
        direct: { count: direct.positions.length / 3, positions: await hash(direct.positions) } };
    }, dist);
    for (const run of result.runs) {
      expect(run.error.code).toBe(run.reason === "abort" ? "REQUEST_CANCELLED" : "RESOURCE_LIMIT_EXCEEDED");
      if (run.reason === "deadline") expect(run.error.details.reason).toBe("worker-deadline-exceeded");
      expect(run.elapsedMs).toBeLessThan(5000);
      expect(run.created).toBe(2);
      expect(run.terminated).toBe(1);
      expect(run.count).toBe(result.expected.count);
      expect(run.positions).toBe(result.expected.positionsSha256);
      expect(run.colors).toBe(result.expected.colorsSha256);
      expect(run.diagnostics).toMatchObject({ active: 0, queued: 0, disposed: false });
    }
    expect(result.direct).toEqual({ count: result.expected.count, positions: result.expected.positionsSha256 });
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
  test(`W16 ${mode}: public file and chunk decoders hard-stop stuck WASM and bound waiting callers`, async ({ page }) => {
    await open(page);
    const result = await page.evaluate(async (dist) => {
      const api = await (dist ? import("/dist/index.js") : import("/src-ts/index.ts"));
      const file = new Uint8Array(await (await fetch("/tests/fixtures/w16/autzen_trim.laz")).arrayBuffer()),
        copc = new Uint8Array(await (await fetch("/tests/fixtures/w16/ellipsoid.copc.laz")).arrayBuffer()),
        header = api.parseLasHeader(copc), view = new DataView(copc.buffer),
        hierarchyOffset = Number(view.getBigUint64(375 + 54 + 40, true)),
        entry = new DataView(copc.buffer, hierarchyOffset, 32),
        offset = Number(entry.getBigUint64(16, true)), length = entry.getInt32(24, true), count = entry.getInt32(28, true),
        chunk = copc.slice(offset, offset + length),
        manifest = await (await fetch("/tests/fixtures/w16/copc-ept-tiles-v1.json")).json();
      const hash = async (array: ArrayBufferView) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
        array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength) as ArrayBuffer))]
        .map((x) => x.toString(16).padStart(2, "0")).join("");
      const NativeWorker = Worker, runs = [];
      for (const kind of ["file", "chunk"]) for (const reason of ["abort", "deadline"]) {
        let created = 0, terminated = 0, entered!: () => void, startupFailed!: (error: Error) => void;
        const stuck = new Promise<void>((resolve, reject) => { entered = resolve; startupFailed = reject; });
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const isLaz = String(url).includes("/laz-worker.");
            super(isLaz ? "/examples/test-w16-stuck-worker.js?native" + (dist ? "&dist" : "") : url, options);
            if (isLaz) {
              created++;
              this.addEventListener("message", ({ data }) => { if (data.state === "stuck-wasm-entered") entered(); });
              this.addEventListener("error", (event) => startupFailed(new Error(event.message)));
            }
          }
          terminate() { terminated++; super.terminate(); }
        };
        try {
          const controller = new AbortController(), start = performance.now();
          const decode = (options: any) => kind === "file" ? api.decodeLaz(file, options)
            : api.decodeLazChunk(chunk, header, count, options);
          const failure = decode({ signal: controller.signal, timeoutMs: reason === "deadline" ? 1500 : 10_000 })
            .then(() => ({ code: "unexpected-success" }), (error: any) => ({ code: error.code, details: error.details }));
          await Promise.race([stuck, failure.then((error: any) => {
            throw Error(`Public decode ended before real stuck-WASM entry: ${JSON.stringify(error)}`);
          })]);
          const queuedController = new AbortController();
          const queuedAbort = decode({ signal: queuedController.signal, timeoutMs: 10_000 })
            .then(() => ({ code: "unexpected-success" }), (error: any) => ({ code: error.code }));
          const queuedDeadline = decode({ timeoutMs: 20 })
            .then(() => ({ code: "unexpected-success" }), (error: any) => ({ code: error.code, details: error.details }));
          queuedController.abort();
          const waiting = { abort: await queuedAbort, deadline: await queuedDeadline, created };
          if (reason === "abort") controller.abort();
          const error = await failure, elapsedMs = performance.now() - start;
          const stopped = { created, terminated };
          window.Worker = NativeWorker;
          const recovered = await decode({ timeoutMs: 10_000 });
          runs.push({ kind, reason, error, elapsedMs, waiting, stopped,
            recovery: { count: recovered.positions.length / 3, positions: await hash(recovered.positions), colors: await hash(recovered.colors) } });
        } finally { window.Worker = NativeWorker; }
      }
      return { runs, expected: { file: manifest.autzen, chunk: manifest.copcRoot } };
    }, dist);
    for (const run of result.runs) {
      expect(run.error.code).toBe(run.reason === "abort" ? "REQUEST_CANCELLED" : "RESOURCE_LIMIT_EXCEEDED");
      if (run.reason === "deadline") expect(run.error.details.reason).toBe("worker-deadline-exceeded");
      expect(run.elapsedMs).toBeLessThan(5000);
      expect(run.waiting.abort.code).toBe("REQUEST_CANCELLED");
      expect(run.waiting.deadline).toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED", details: { reason: "worker-deadline-exceeded", timeoutMs: 20 } });
      expect(run.waiting.created).toBe(1);
      expect(run.stopped).toEqual({ created: 1, terminated: 1 });
      const expected = result.expected[run.kind as "file" | "chunk"];
      expect(run.recovery).toEqual({ count: expected.count, positions: expected.positionsSha256, colors: expected.colorsSha256 });
    }
  });
  test(`W16 ${mode}: a supplied worker pool creates a fresh native heap for every decode`, async ({ page }, testInfo) => {
    await open(page);
    const result = await page.evaluate(async (dist) => {
      const api = await (dist ? import("/dist/index.js") : import("/src-ts/index.ts"));
      const bytes = new Uint8Array(await (await fetch("/tests/fixtures/w16/autzen_trim.laz")).arrayBuffer()),
        manifest = await (await fetch("/tests/fixtures/w16/copc-ept-tiles-v1.json")).json();
      const hash = async (array: ArrayBufferView) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
        array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength) as ArrayBuffer))]
        .map((x) => x.toString(16).padStart(2, "0")).join("");
      const runs = [];
      for (const cached of [false, true]) {
        let created = 0;
        const pool = new api.Forge3DWorkerPool({ size: 1, mainThreadHandler: api.createPointCloudWorkerHandler(),
          workerFactory: () => {
            created++;
            const worker = new Worker("/examples/test-w16-heap-worker.js?" + (dist ? "dist&" : "") + (cached ? "cached" : ""), { type: "module" });
            const channel = new MessageChannel(); worker.postMessage({ port: channel.port2 }, [channel.port2]);
            return { port: channel.port1, terminate: () => worker.terminate() };
          } });
        try {
          const results = [];
          for (let i = 0; i < 2; i++) {
            const dataset = await api.openLaz(bytes, { workerPool: pool });
            try {
              const data = await dataset.readPoints("0-0-0-0");
              results.push({ count: dataset.totalPoints, positions: await hash(data.positions), colors: await hash(data.colors) });
            } finally { dataset.dispose(); }
          }
          // Query the same RPC port after both jobs; worker imports need no
          // Playwright route support and no cross-port telemetry ordering.
          const heaps = await pool.run({ kind: "test-heap-observations" }, { timeoutMs: 1000, requireHardStop: true });
          runs.push({ cached, created, heaps, results });
        } finally { pool.dispose(); }
      }
      return { runs, expected: manifest.autzen };
    }, dist);
    await testInfo.attach("w16-native-heap-proof.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    console.log("W16 native heap proof " + JSON.stringify({ mode, ...result }));
    for (const run of result.runs) {
      expect(run.created).toBe(1);
      expect(run.heaps).toHaveLength(2);
      for (const output of run.results) expect(output).toEqual({ count: result.expected.count,
        positions: result.expected.positionsSha256, colors: result.expected.colorsSha256 });
    }
    const assertFresh = (run: any) => {
      expect(run.heaps[1].module).not.toBe(run.heaps[0].module);
      expect(run.heaps[1].memory).not.toBe(run.heaps[0].memory);
      expect(run.heaps[1].buffer).not.toBe(run.heaps[0].buffer);
    };
    assertFresh(result.runs[0]);
    expect(result.runs[1].heaps[1]).toEqual(result.runs[1].heaps[0]);
    expect(() => assertFresh(result.runs[1])).toThrow();
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
