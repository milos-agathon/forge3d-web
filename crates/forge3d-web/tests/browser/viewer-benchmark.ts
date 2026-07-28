import type { Page } from "@playwright/test";

export interface BenchmarkEnvironmentSignals {
  browserZoom: number;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unavailable";
  thermalSignalProvenance?: string;
  lowPowerMode?: boolean | "unavailable";
  lowPowerSignalProvenance?: string;
}

export async function runViewerBenchmark(
  page: Page,
  signals: BenchmarkEnvironmentSignals,
) {
  return page.evaluate(async (environment) => {
    const assertEqual = (
      actual: unknown,
      expected: unknown,
      label: string,
    ) => {
      if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
      }
    };
    const nextAnimationFrame = () =>
      new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const waitForSubmittedFrame = async (viewer: BenchmarkViewer) => {
      const initial = viewer.getDiagnostics().submittedFrames;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await nextAnimationFrame();
        if (viewer.getDiagnostics().submittedFrames > initial) {
          return;
        }
      }
      throw new Error("viewer did not submit the initial benchmark frame");
    };
    const applyRafSamples = (
      viewer: BenchmarkViewer,
      samples: BenchmarkView[],
    ) =>
      new Promise<void>((resolve) => {
        let index = 0;
        const apply = () => {
          viewer.setView(samples[index]);
          index += 1;
          if (index === samples.length) {
            resolve();
            return;
          }
          requestAnimationFrame(apply);
        };
        requestAnimationFrame(apply);
      });
    const applyMeasuredRafSamples = (
      viewer: BenchmarkViewer,
      samples: BenchmarkView[],
    ) =>
      new Promise<{
        before: BenchmarkDiagnostics;
        after: BenchmarkDiagnostics;
        timestamps: number[];
      }>((resolve) => {
        const timestamps: number[] = [];
        let before: BenchmarkDiagnostics | undefined;
        let index = 0;
        const apply = (timestamp: number) => {
          if (index === samples.length) {
            timestamps.push(timestamp);
            resolve({
              before: before as BenchmarkDiagnostics,
              after: viewer.getDiagnostics(),
              timestamps,
            });
            return;
          }
          if (index === 0) {
            before = viewer.getDiagnostics();
          }
          timestamps.push(timestamp);
          viewer.setView(samples[index]);
          index += 1;
          requestAnimationFrame(apply);
        };
        requestAnimationFrame(apply);
      });
    const sha256 = async (bytes: ArrayBuffer) => {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    };

    const fixture = (
      window as typeof window & {
        __forge3dInteractiveViewer?: {
          canvas: HTMLCanvasElement;
          create: (
            options?: Record<string, unknown>,
          ) => Promise<BenchmarkViewer>;
        };
      }
    ).__forge3dInteractiveViewer;
    if (!fixture) {
      throw new Error("interactive viewer fixture is not loaded");
    }
    const viewer = await fixture.create({
      resize: false,
      controls: { keyboard: true },
    });
    const canvas = fixture.canvas;
    try {

      const [manifestResponse, terrainResponse, traceResponse] = await Promise.all([
      fetch("/tests/browser/benchmark/benchmark-manifest-v1.json"),
      fetch("/tests/browser/benchmark/benchmark-terrain-v1.f32le"),
      fetch("/tests/browser/benchmark/benchmark-trace-v1.json"),
    ]);
    if (!manifestResponse.ok || !terrainResponse.ok || !traceResponse.ok) {
      throw new Error("failed to load the frozen benchmark assets");
    }
    const manifestBytes = await manifestResponse.arrayBuffer();
    const terrainBytes = await terrainResponse.arrayBuffer();
    const traceBytes = await traceResponse.arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const trace = JSON.parse(new TextDecoder().decode(traceBytes));

    assertEqual(manifest.id, "forge3d-viewer-benchmark-v1", "benchmark ID");
    assertEqual(
      trace.id,
      "forge3d-viewer-benchmark-trace-v1",
      "trace ID",
    );
    assertEqual(trace.warmup.length, 120, "warm-up sample count");
    assertEqual(trace.measurement.length, 600, "measurement sample count");

    canvas.style.width = "320px";
    canvas.style.height = "320px";
    viewer.resize({ width: 320, height: 320, devicePixelRatio: 2 });
    viewer.setTerrain({
      width: 512,
      height: 512,
      heights: new Float32Array(terrainBytes),
    });
    await waitForSubmittedFrame(viewer);
    canvas.focus();

    let visibilityChangeCount = 0;
    let windowBlurCount = 0;
    const onVisibilityChange = () => {
      visibilityChangeCount += 1;
    };
    const onBlur = () => {
      windowBlurCount += 1;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);

    const visualViewportScale = () => window.visualViewport?.scale ?? 1;
    const visibilityStateBefore = document.visibilityState;
    const documentHasFocusBefore = document.hasFocus();
    const viewportScaleBefore = visualViewportScale();
    const browserZoomBefore = environment.browserZoom;
    const devicePixelRatioBefore = window.devicePixelRatio;
    const thermalStateBefore = environment.thermalState ?? "unavailable";
    const lowPowerModeBefore = environment.lowPowerMode ?? "unavailable";
    let before;
    let after;
    let timestamps;

    try {
      await applyRafSamples(viewer, trace.warmup);
      ({ before, after, timestamps } = await applyMeasuredRafSamples(
        viewer,
        trace.measurement,
      ));
    } finally {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
    }

    const intervals = timestamps.slice(1).map(
      (timestamp, index) => timestamp - timestamps[index],
    );
    const sortedIntervals = [...intervals].sort((left, right) => left - right);
    const submittedFramesDelta =
      after.submittedFrames - before.submittedFrames;
    const skippedFramesDelta = after.skippedFrames - before.skippedFrames;
    const measuredDurationMs = timestamps[600] - timestamps[0];

      return {
      id: manifest.id,
      manifestSha256: await sha256(manifestBytes),
      terrainSha256: await sha256(terrainBytes),
      traceSha256: await sha256(traceBytes),
      canvasCssWidth: canvas.clientWidth,
      canvasCssHeight: canvas.clientHeight,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      devicePixelRatio: 2,
      browserZoomBefore,
      browserZoomAfter:
        browserZoomBefore *
        (window.devicePixelRatio / devicePixelRatioBefore),
      viewportScaleBefore,
      viewportScaleAfter: visualViewportScale(),
      traceVersion: manifest.traceVersion,
      visibilityStateBefore,
      visibilityStateAfter: document.visibilityState,
      documentHasFocusBefore,
      documentHasFocusAfter: document.hasFocus(),
      visibilityChangeCount,
      windowBlurCount,
      thermalStateBefore,
      thermalStateAfter: environment.thermalState ?? "unavailable",
      thermalSignalProvenance:
        environment.thermalSignalProvenance ?? "browser API unavailable",
      lowPowerModeBefore,
      lowPowerModeAfter: environment.lowPowerMode ?? "unavailable",
      lowPowerSignalProvenance:
        environment.lowPowerSignalProvenance ?? "browser API unavailable",
      warmupSamples: trace.warmup.length,
      measurementSamples: trace.measurement.length,
      rafTimestampsMs: timestamps,
      rafIntervalsMs: intervals,
      traceSamplesApplied: trace.measurement.length,
      catchUpSamples: 0,
      submittedFramesBefore: before.submittedFrames,
      submittedFramesAfter: after.submittedFrames,
      submittedFramesDelta,
      skippedFramesBefore: before.skippedFrames,
      skippedFramesAfter: after.skippedFrames,
      skippedFramesDelta,
      measuredDurationMs,
      framesPerSecond: (submittedFramesDelta * 1000) / measuredDurationMs,
      p95RafIntervalMs: sortedIntervals[569],
      };
    } finally {
      viewer.dispose();
    }
  }, signals);
}

interface BenchmarkViewer {
  setTerrain(terrain: {
    width: number;
    height: number;
    heights: Float32Array;
  }): void;
  setView(view: BenchmarkView): void;
  resize(size: {
    width: number;
    height: number;
    devicePixelRatio: number;
  }): void;
  getDiagnostics(): BenchmarkDiagnostics;
  dispose(): void;
}

interface BenchmarkView {
  target: [number, number, number];
  distance: number;
  yawDegrees: number;
  pitchDegrees: number;
  fovYDegrees: number;
  near: number;
  far: number;
}

interface BenchmarkDiagnostics {
  submittedFrames: number;
  skippedFrames: number;
}
