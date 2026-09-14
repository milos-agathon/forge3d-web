/**
 * Browser-owned forge3d-viewer-benchmark-v1 callback. Keep this function
 * self-contained: Playwright serializes it into the page and the hardware
 * fixture imports it directly.
 */
export async function runViewerBenchmarkInBrowser({ environment, assetUrls, includeSchedulingEvidence = false }) {
  const equal = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const isSecureOrLoopbackUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    } catch {
      return false;
    }
  };
  const fixture = window.__forge3dInteractiveViewer;
  if (!fixture?.canvas || typeof fixture.create !== "function") {
    throw new Error("interactive viewer fixture is not loaded");
  }
  for (const [name, url] of Object.entries(assetUrls ?? {})) {
    if (!["manifest", "terrain", "trace"].includes(name) ||
        typeof url !== "string" || !isSecureOrLoopbackUrl(url)) {
      throw new Error("benchmark asset URLs must use HTTPS or loopback HTTP");
    }
  }
  const viewer = await fixture.create({ resize: false, controls: { keyboard: true }, onError: window.__forge3dChr03OnError });
  try {
    const responses = await Promise.all([
      fetch(assetUrls.manifest, { cache: "no-store" }),
      fetch(assetUrls.terrain, { cache: "no-store" }),
      fetch(assetUrls.trace, { cache: "no-store" }),
    ]);
    if (responses.some((response) => !response.ok)) {
      throw new Error("failed to load the frozen benchmark assets");
    }
    const [manifestBytes, terrainBytes, traceBytes] = await Promise.all(
      responses.map((response) => response.arrayBuffer()),
    );
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const trace = JSON.parse(new TextDecoder().decode(traceBytes));
    equal(manifest.id, "forge3d-viewer-benchmark-v1", "benchmark ID");
    equal(trace.id, "forge3d-viewer-benchmark-trace-v1", "trace ID");
    equal(trace.warmup.length, 120, "warm-up sample count");
    equal(trace.measurement.length, 600, "measurement sample count");

    const canvas = fixture.canvas;
    canvas.style.width = "320px";
    canvas.style.height = "320px";
    viewer.resize({ width: 320, height: 320, devicePixelRatio: 2 });
    viewer.setTerrain({ width: 512, height: 512, heights: new Float32Array(terrainBytes) });
    const initialSubmitted = viewer.getDiagnostics().submittedFrames;
    for (let attempt = 0; attempt < 120 &&
      viewer.getDiagnostics().submittedFrames === initialSubmitted; attempt += 1) {
      await nextFrame();
    }
    if (viewer.getDiagnostics().submittedFrames === initialSubmitted) {
      throw new Error("viewer did not submit the initial benchmark frame");
    }
    canvas.focus();
    const visibilityStateBefore = document.visibilityState;
    const documentHasFocusBefore = document.hasFocus();
    const viewportScaleBefore = window.visualViewport?.scale ?? 1;
    const browserZoomBefore = environment.browserZoom;
    const devicePixelRatioBefore = window.devicePixelRatio;
    let visibilityChangeCount = 0;
    let windowBlurCount = 0;
    const onVisibility = () => { visibilityChangeCount += 1; };
    const onBlur = () => { windowBlurCount += 1; };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);

    const applySamples = (samples, measured) => new Promise((resolve) => {
      const timestamps = [];
      let index = 0;
      let before;
      let maxOutstandingFrames = 0;
      let pendingBeforeInvalidation = 0;
      let pendingAfterInvalidation = 0;
      let duplicateRafObserved = false;
      const apply = (timestamp) => {
        if (index === samples.length) {
          if (measured) timestamps.push(timestamp);
          const after = viewer.getDiagnostics();
          const finalOutstandingFrames = after.ownedAnimationFrameCount;
          maxOutstandingFrames = Math.max(maxOutstandingFrames, finalOutstandingFrames);
          resolve({ before, after, timestamps, maxOutstandingFrames, finalOutstandingFrames,
            pendingBeforeInvalidation, pendingAfterInvalidation, duplicateRafObserved });
          return;
        }
        const diagnostics = viewer.getDiagnostics();
        if (index === 0) before = diagnostics;
        if (measured) timestamps.push(timestamp);
        const pendingBefore = diagnostics.ownedAnimationFrameCount;
        pendingBeforeInvalidation += pendingBefore;
        maxOutstandingFrames = Math.max(maxOutstandingFrames, pendingBefore);
        viewer.setView(samples[index]);
        index += 1;
        requestAnimationFrame(apply);
        const afterInvalidation = viewer.getDiagnostics();
        const pendingAfter = afterInvalidation.ownedAnimationFrameCount;
        pendingAfterInvalidation += pendingAfter;
        maxOutstandingFrames = Math.max(maxOutstandingFrames, pendingAfter);
        duplicateRafObserved ||= pendingAfter > 1;
      };
      requestAnimationFrame(apply);
    });
    let measured;
    try {
      await applySamples(trace.warmup, false);
      measured = await applySamples(trace.measurement, true);
    } finally {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
    }
    const { before, after, timestamps } = measured;
    const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]);
    const sorted = [...intervals].sort((left, right) => left - right);
    const submittedFramesDelta = after.submittedFrames - before.submittedFrames;
    const skippedFramesDelta = after.skippedFrames - before.skippedFrames;
    const measuredDurationMs = timestamps[600] - timestamps[0];
    const result = {
      id: manifest.id,
      manifestSha256: await digest(manifestBytes),
      terrainSha256: await digest(terrainBytes),
      traceSha256: await digest(traceBytes),
      canvasCssWidth: canvas.clientWidth, canvasCssHeight: canvas.clientHeight,
      backingWidth: canvas.width, backingHeight: canvas.height, devicePixelRatio: 2,
      browserZoomBefore,
      browserZoomAfter: browserZoomBefore * (window.devicePixelRatio / devicePixelRatioBefore),
      viewportScaleBefore, viewportScaleAfter: window.visualViewport?.scale ?? 1,
      traceVersion: manifest.traceVersion,
      visibilityStateBefore, visibilityStateAfter: document.visibilityState,
      documentHasFocusBefore, documentHasFocusAfter: document.hasFocus(),
      visibilityChangeCount, windowBlurCount,
      thermalStateBefore: environment.thermalState ?? "unavailable",
      thermalStateAfter: environment.thermalState ?? "unavailable",
      thermalSignalProvenance: environment.thermalSignalProvenance ?? "browser API unavailable",
      lowPowerModeBefore: environment.lowPowerMode ?? "unavailable",
      lowPowerModeAfter: environment.lowPowerMode ?? "unavailable",
      lowPowerSignalProvenance: environment.lowPowerSignalProvenance ?? "browser API unavailable",
      warmupSamples: trace.warmup.length, measurementSamples: trace.measurement.length,
      rafTimestampsMs: timestamps, rafIntervalsMs: intervals,
      traceSamplesApplied: trace.measurement.length, catchUpSamples: 0,
      submittedFramesBefore: before.submittedFrames, submittedFramesAfter: after.submittedFrames,
      submittedFramesDelta, skippedFramesBefore: before.skippedFrames,
      skippedFramesAfter: after.skippedFrames, skippedFramesDelta,
      measuredDurationMs, framesPerSecond: (submittedFramesDelta * 1000) / measuredDurationMs,
      p95RafIntervalMs: sorted[569],
    };
    if (includeSchedulingEvidence) {
      result.scheduling = {
        observationSamples: trace.measurement.length,
        pendingBeforeInvalidation: measured.pendingBeforeInvalidation,
        pendingAfterInvalidation: measured.pendingAfterInvalidation,
        maxOutstandingFrames: measured.maxOutstandingFrames,
        finalOutstandingFrames: measured.finalOutstandingFrames,
        duplicateRafObserved: measured.duplicateRafObserved,
      };
    }
    return result;
  } finally {
    viewer.dispose();
  }
}
