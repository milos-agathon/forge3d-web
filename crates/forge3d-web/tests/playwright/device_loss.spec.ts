import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

test("generated WASM propagates one normalized device-loss event", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    const bridge = await import("/pkg/forge3d_web.js");
    await bridge.default({
      module_or_path: new URL(
        "/pkg/forge3d_web_bg.wasm",
        window.location.href,
      ),
    });
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    document.body.append(canvas);
    const runtime = await bridge.Forge3DRuntime.create(canvas, {
      diagnostics: true,
      width: 32,
      height: 32,
      devicePixelRatio: 1,
    });
    const events: Array<{ code?: string; message?: string }> = [];
    runtime.setDeviceLostCallback((error: any) => {
      events.push({ code: error.code, message: error.message });
    });
    runtime.simulateDeviceLossForTesting();
    runtime.simulateDeviceLossForTesting();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let renderCode;
    try {
      runtime.render();
    } catch (error: any) {
      renderCode = error.code;
    }
    const capabilities = runtime.getCapabilities();
    runtime.dispose();
    canvas.remove();
    return { events, renderCode, capabilities };
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.code).toBe("DEVICE_LOST");
  expect(result.events[0]?.message).toContain(
    "diagnostic device-loss simulation",
  );
  expect(result.renderCode).toBe("DEVICE_LOST");
  expect(result.capabilities.deviceState).toBe("lost");
});

test("generated WASM loss traverses the facade into one viewer recovery", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-interactive-viewer.html");
  const result = await page.evaluate(async () => {
    const { simulateViewerDeviceLossForTests } = await import(
      "/src-ts/viewer.ts"
    );
    const transitions: string[] = [];
    const errors: string[] = [];
    const viewer = await window.__forge3dInteractiveViewer.create({
      runtime: { diagnostics: true },
      controls: false,
      resize: false,
      onStatusChange: ({ previous, current }: any) => {
        transitions.push(`${previous}->${current}`);
      },
      onError: (error: any) => errors.push(error.code),
    });
    simulateViewerDeviceLossForTests(viewer);
    await new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 10_000;
      const poll = () => {
        if (viewer.status === "ready" && viewer.getDiagnostics().generation === 2) {
          resolve();
        } else if (viewer.status === "failed" || performance.now() > deadline) {
          reject(new Error(`viewer recovery ended in ${viewer.status}`));
        } else {
          requestAnimationFrame(poll);
        }
      };
      poll();
    });
    const diagnostics = viewer.getDiagnostics();
    viewer.dispose();
    return { transitions, errors, diagnostics };
  });

  expect(result.transitions).toContain("ready->recovering");
  expect(result.transitions).toContain("recovering->ready");
  expect(result.errors).toEqual(["DEVICE_LOST"]);
  expect(result.diagnostics.generation).toBe(2);
  expect(result.diagnostics.recoveryAttempts).toBe(1);
  expect(result.diagnostics.activeRuntimes).toBe(1);
});

test("diagnostic failures execute surface recovery and shader normalization", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    const bridge = await import("/pkg/forge3d_web.js");
    await bridge.default({
      module_or_path: new URL(
        "/pkg/forge3d_web_bg.wasm",
        window.location.href,
      ),
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const runtime = await bridge.Forge3DRuntime.create(canvas, {
      diagnostics: true,
      width: 64,
      height: 64,
      devicePixelRatio: 1,
    });
    runtime.setTerrain({
      width: 2,
      height: 2,
      heights: new Float32Array([0, 0.25, 0.75, 1]),
    });
    const outdated = runtime.simulateSurfaceFailureForTesting(
      "outdated",
      false,
    );
    const renderedAfterReconfigure = runtime.render();
    const lost = runtime.simulateSurfaceFailureForTesting("lost", true);
    const renderedAfterRecreate = runtime.render();
    let shaderCode;
    try {
      await runtime.simulateShaderCompilationFailureForTesting();
    } catch (error: any) {
      shaderCode = error.code;
    }
    const capabilities = runtime.getCapabilities();
    runtime.dispose();
    canvas.remove();
    return {
      outdated,
      lost,
      renderedAfterReconfigure,
      renderedAfterRecreate,
      shaderCode,
      capabilities,
    };
  });

  expect(result.outdated).toMatchObject({
    action: "reconfigure",
    pipelineRebuilt: false,
  });
  expect(result.renderedAfterReconfigure).toBe(true);
  expect(result.lost.action).toBe("recreate");
  expect(result.lost.oldSurfaceFormat).not.toBe(result.lost.surfaceFormat);
  expect(result.lost.pipelineRebuilt).toBe(true);
  expect(result.renderedAfterRecreate).toBe(true);
  expect(result.capabilities.surfaceFormat).toBe(result.lost.surfaceFormat);
  expect(result.shaderCode).toBe("SHADER_COMPILATION_FAILED");
});

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
