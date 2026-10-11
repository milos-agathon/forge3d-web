import { makeTraceFixture, sha256 } from "./w17-fixture.js";

// Local stress evidence records its own resolution and adapter. It cannot attest
// the W00 1080p physical profiles; those require their pinned hardware hosts.
export async function runTraceSoak(s, seconds = 600) {
  const adapter = await navigator.gpu.requestAdapter(),
    device = await adapter.requestDevice(),
    scene = makeTraceFixture(s);
  const tracer = await s.PathTracer.create(
    {
      width: 32,
      height: 20,
      maxBounces: 2,
      seed: 1597463007,
      engine: "wavefront",
    },
    { device },
  );
  const timings = [],
    hashes = new Map();
  let frames = 0,
    coverageMin = 640,
    replayErrors = 0,
    cpuPeak = 0,
    gpuPeak = 0,
    heapPeak = 0;
  try {
    await tracer.setScene(scene);
    await tracer.render();
    const started = performance.now();
    let lastLog = started;
    while (performance.now() - started < seconds * 1000) {
      const key = frames % 256,
        sphere = key % 2 !== 0,
        x = sphere
          ? 140 + 3 * Math.floor(key / 2)
          : ((Math.floor(key / 2) % 16) - 8) * 6;
      await tracer.setCamera({ origin: [x, 0, 5], target: [x, 0, 0] });
      const before = performance.now(),
        result = await tracer.render();
      timings.push(performance.now() - before);
      coverageMin = Math.min(
        coverageMin,
        result.id.filter((v) => v !== 0).length,
      );
      const hash = await sha256(result.color);
      if (hashes.has(key) && hashes.get(key) !== hash) replayErrors++;
      hashes.set(key, hash);
      const report = tracer.memoryReport();
      cpuPeak = Math.max(cpuPeak, report.cpuBytes);
      gpuPeak = Math.max(gpuPeak, report.gpuBytes);
      heapPeak = Math.max(heapPeak, performance.memory?.usedJSHeapSize ?? 0);
      frames++;
      if (performance.now() - lastLog >= 30000) {
        console.log(
          "W17 soak " +
            Math.floor((performance.now() - started) / 1000) +
            "s, " +
            frames +
            " frames",
        );
        lastLog = performance.now();
      }
    }
    timings.sort((a, b) => a - b);
    const elapsedMs = performance.now() - started;
    tracer.dispose();
    const m = tracer.memoryReport();
    return {
      fixtureId: "trace-sdf-v1",
      triangles: 65536,
      sdfPrimitives: 128,
      seed: 1597463007,
      width: 32,
      height: 20,
      sppPerFrame: 1,
      engine: "wavefront",
      elapsedMs,
      frames,
      cameraKeys: hashes.size,
      coverageMin,
      replayErrors,
      frameTimeP95Ms: timings[Math.floor(timings.length * 0.95)],
      cpuPeak,
      gpuPeak,
      heapPeak,
      residualBytes: m.cpuBytes + m.gpuBytes + m.cacheBytes,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      userAgent: navigator.userAgent,
      hardwareQualification: "unqualified-local-stress",
      physicalProfilesPending: ["reference-discrete", "reference-integrated"],
    };
  } finally {
    tracer.dispose();
    scene.sdf.dispose();
    device.destroy();
  }
}
