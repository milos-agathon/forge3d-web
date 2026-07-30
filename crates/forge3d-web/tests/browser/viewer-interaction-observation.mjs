export const MINIMUM_VIEWER_INTERACTION_DURATION_MS = 10_000;
export const VIEWER_INTERACTION_ERROR_KEY =
  "__forge3dViewerInteractionObservationErrors";

const NORMALIZED_ERROR_CODES = new Set([
  "WEBGPU_UNAVAILABLE",
  "WEBGPU_ADAPTER_UNAVAILABLE",
  "INSECURE_CONTEXT",
  "WASM_LOAD_FAILED",
  "DEVICE_REQUEST_FAILED",
  "DEVICE_LOST",
  "SURFACE_CREATE_FAILED",
  "SURFACE_LOST",
  "SURFACE_OUTDATED",
  "OUT_OF_MEMORY",
  "UNSUPPORTED_FEATURE",
  "INVALID_INPUT",
  "IO_ERROR",
  "REQUEST_CANCELLED",
  "SHADER_COMPILATION_FAILED",
  "INTERNAL_ERROR",
  "RESOURCE_LIMIT_EXCEEDED",
  "RUNTIME_DISPOSED",
]);

export async function runViewerInteractionObservation(
  page,
  {
    minimumDurationMs = MINIMUM_VIEWER_INTERACTION_DURATION_MS,
    disposeViewer = false,
  } = {},
) {
  if (!Number.isFinite(minimumDurationMs) || minimumDurationMs < 10_000) {
    throw new Error(
      "viewer interaction observation requires at least 10000ms",
    );
  }

  const uncapturedValidationErrors = [];
  const onConsole = (message) => {
    if (isWebGpuValidationError(message.text())) {
      uncapturedValidationErrors.push(message.text());
    }
  };
  const onPageError = (error) => {
    const description = `${error.name}: ${error.message}`;
    if (isWebGpuValidationError(description)) {
      uncapturedValidationErrors.push(description);
    }
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  try {
    const result = await page.evaluate(
      async ({ durationMs, errorKey, normalizedErrorCodes, disposeAfter }) => {
        const fixture = window.__forge3dInteractiveViewer;
        if (!fixture?.canvas || typeof fixture.create !== "function") {
          throw new Error("interactive viewer fixture is not loaded");
        }
        const normalizeErrorCode = (error) => {
          const code =
            typeof error?.code === "string"
              ? error.code
              : "INTERNAL_ERROR";
          return normalizedErrorCodes.includes(code)
            ? code
            : "INTERNAL_ERROR";
        };
        window[errorKey] = [];
        const hadLiveViewer = Boolean(
          fixture.viewer && !fixture.viewer.disposed,
        );
        const viewer = await fixture.create({
          resize: false,
          controls: { keyboard: true },
          onError: (error) => {
            window[errorKey]?.push(normalizeErrorCode(error));
          },
        });
        const canvas = fixture.canvas;
        const originalCanvas = canvas;
        const nextAnimationFrame = () =>
          new Promise((resolve) => requestAnimationFrame(resolve));

        try {
          const traceResponse = await fetch(
            "/tests/browser/benchmark/benchmark-trace-v1.json",
          );
          if (!traceResponse.ok) {
            throw new Error(
              "failed to load the frozen interaction trace",
            );
          }
          const trace = await traceResponse.json();
          if (
            trace.id !== "forge3d-viewer-benchmark-trace-v1" ||
            !Array.isArray(trace.measurement) ||
            trace.measurement.length !== 600
          ) {
            throw new Error("frozen interaction trace contract mismatch");
          }

          await nextAnimationFrame();
          await nextAnimationFrame();
          const before = viewer.getDiagnostics();
          const viewBefore = viewer.getView();
          const visibilityStateBefore = document.visibilityState;
          let visibilityChangeCount = 0;
          const onVisibilityChange = () => {
            visibilityChangeCount += 1;
          };
          document.addEventListener(
            "visibilitychange",
            onVisibilityChange,
          );
          canvas.focus();

          let loop;
          try {
            loop = await new Promise((resolve) => {
              let startedAt;
              let traceSamplesApplied = 0;
              const apply = (timestamp) => {
                if (startedAt === undefined) {
                  startedAt = timestamp;
                }
                const elapsedMs = timestamp - startedAt;
                if (elapsedMs >= durationMs) {
                  resolve({
                    elapsedMs,
                    traceSamplesApplied,
                  });
                  return;
                }
                viewer.setView(
                  trace.measurement[
                    traceSamplesApplied % trace.measurement.length
                  ],
                );
                traceSamplesApplied += 1;
                requestAnimationFrame(apply);
              };
              requestAnimationFrame(apply);
            });
            await nextAnimationFrame();
            await nextAnimationFrame();
          } finally {
            document.removeEventListener(
              "visibilitychange",
              onVisibilityChange,
            );
          }

          const after = viewer.getDiagnostics();
          const viewAfter = viewer.getView();
          return {
            elapsedMs: loop.elapsedMs,
            traceSamplesApplied: loop.traceSamplesApplied,
            renderRequestsDelta:
              after.renderRequests - before.renderRequests,
            submittedFramesDelta:
              after.submittedFrames - before.submittedFrames,
            skippedFramesDelta:
              after.skippedFrames - before.skippedFrames,
            visibilityStateBefore,
            visibilityStateAfter: document.visibilityState,
            visibilityChangeCount,
            viewerStatus: viewer.status,
            sameCanvas: fixture.canvas === originalCanvas,
            viewChanged:
              JSON.stringify(viewAfter) !== JSON.stringify(viewBefore),
            normalizedViewerErrorCodes: [...window[errorKey]],
          };
        } finally {
          if (disposeAfter && !hadLiveViewer) {
            viewer.dispose();
          }
        }
      },
      {
        durationMs: minimumDurationMs,
        errorKey: VIEWER_INTERACTION_ERROR_KEY,
        normalizedErrorCodes: [...NORMALIZED_ERROR_CODES],
        disposeAfter: disposeViewer,
      },
    );
    await page.waitForTimeout(50);
    const lateViewerErrorCodes = await page.evaluate((errorKey) => {
      const codes = Array.isArray(window[errorKey])
        ? [...window[errorKey]]
        : [];
      delete window[errorKey];
      return codes;
    }, VIEWER_INTERACTION_ERROR_KEY);
    const normalizedErrorCodes = [
      ...new Set([
        ...result.normalizedViewerErrorCodes,
        ...lateViewerErrorCodes,
        ...uncapturedValidationErrors.map(() => "INTERNAL_ERROR"),
      ]),
    ];
    const observation = {
      kind: "forge3d-viewer-interaction-observation-v1",
      minimumDurationMs,
      elapsedMs: result.elapsedMs,
      timingSource: "requestAnimationFrame",
      traceId: "forge3d-viewer-benchmark-trace-v1",
      traceSamplesApplied: result.traceSamplesApplied,
      renderRequestsDelta: result.renderRequestsDelta,
      submittedFramesDelta: result.submittedFramesDelta,
      skippedFramesDelta: result.skippedFramesDelta,
      normalizedErrorCodes,
      visibilityStateBefore: result.visibilityStateBefore,
      visibilityStateAfter: result.visibilityStateAfter,
      visibilityChangeCount: result.visibilityChangeCount,
      viewerStatus: result.viewerStatus,
      sameCanvas: result.sameCanvas,
      viewChanged: result.viewChanged,
      physicalSupportEvidence: false,
      supportPromotionEligible: false,
    };
    validateViewerInteractionObservation(observation);
    return observation;
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

export function validateViewerInteractionObservation(observation) {
  if (
    observation.kind !==
    "forge3d-viewer-interaction-observation-v1"
  ) {
    throw new Error("unexpected viewer interaction observation kind");
  }
  if (
    !Number.isFinite(observation.elapsedMs) ||
    observation.elapsedMs < observation.minimumDurationMs ||
    observation.minimumDurationMs <
      MINIMUM_VIEWER_INTERACTION_DURATION_MS
  ) {
    throw new Error(
      "viewer interaction observation did not reach 10000ms",
    );
  }
  if (observation.normalizedErrorCodes.length !== 0) {
    throw new Error(
      "viewer interaction observation captured viewer or WebGPU validation errors",
    );
  }
  if (
    observation.traceSamplesApplied <= 0 ||
    observation.renderRequestsDelta !==
      observation.traceSamplesApplied ||
    observation.submittedFramesDelta +
      observation.skippedFramesDelta !==
      observation.traceSamplesApplied
  ) {
    throw new Error(
      "viewer interaction observation did not continuously render its trace",
    );
  }
  if (
    observation.visibilityStateBefore !== "visible" ||
    observation.visibilityStateAfter !== "visible" ||
    observation.visibilityChangeCount !== 0
  ) {
    throw new Error(
      "viewer interaction observation lost visible document state",
    );
  }
  if (
    observation.viewerStatus !== "ready" ||
    !observation.sameCanvas ||
    !observation.viewChanged
  ) {
    throw new Error(
      "viewer interaction observation did not preserve a ready viewer",
    );
  }
  if (
    observation.physicalSupportEvidence !== false ||
    observation.supportPromotionEligible !== false
  ) {
    throw new Error(
      "viewer interaction observation must remain non-promotional",
    );
  }
  return observation;
}

export function isWebGpuValidationError(message) {
  return /\bGPUValidationError\b|(?:\bWebGPU\b|\bwgpu\b|\bGPU\b)[\s\S]{0,160}\bvalidation\b|\bvalidation\b[\s\S]{0,160}(?:\bWebGPU\b|\bwgpu\b|\bGPU\b)/iu.test(
    message,
  );
}
