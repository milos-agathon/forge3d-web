import { expect, test } from "../browser/webgpu-fixture";
import { isLiveChromiumLaunchArgumentSource } from "../../scripts/browser-launch-provenance.mjs";

test("reports browser WebGPU diagnostics", async ({
  webgpuDiagnostics: diagnostics,
}) => {
  expect(diagnostics.project.project).toBeTruthy();
  expect(diagnostics.project.browserName).toBeTruthy();
  expect(diagnostics.project.channel).toBeTruthy();
  expect(diagnostics.project.lane).toBeTruthy();
  expect(diagnostics.browserVersion).toBeTruthy();
  expect(diagnostics.userAgent).toBeTruthy();
  expect(diagnostics.secureContext).toBe(true);
  expect(diagnostics.hasNavigatorGpu).toBe(true);
  expect(diagnostics.adapterAvailable).toBe(true);
  expect(diagnostics.adapter.requestAttempted).toBe(true);
  expect(diagnostics.adapter.acquired).toBe(true);
  expect(diagnostics.adapter.limits.maxTextureDimension2D).toBeGreaterThan(0);
  expect(diagnostics.adapter.limits.maxBufferSize).toBeGreaterThan(0);
  expect(diagnostics.viewerRuntime).toMatchObject({
    attempted: true,
    created: true,
    status: "ready",
    deviceState: "ready",
    disposedStatus: "disposed",
    activeRuntimesAfterDispose: 0,
    error: null,
  });
  expect(diagnostics.launch.configuredArguments).toEqual(
    diagnostics.project.launchArgs,
  );
  expect(diagnostics.launch.observed).toBe(true);
  expect(diagnostics.launch.effectiveArguments.length).toBeGreaterThan(0);
  expect(
    isLiveChromiumLaunchArgumentSource(
      diagnostics.launch.observationSource,
    ),
  ).toBe(true);
  expect(
    diagnostics.launch.configuredLaunchFlagsPresent,
  ).toBe(
    Object.values(diagnostics.launch.flagPresence).some(
      ({ configured }) => configured,
    ),
  );
  expect(
    diagnostics.launch.effectiveLaunchFlagsPresent,
  ).toBe(
    Object.values(diagnostics.launch.flagPresence).some(
      ({ observed }) => observed,
    ),
  );
});
