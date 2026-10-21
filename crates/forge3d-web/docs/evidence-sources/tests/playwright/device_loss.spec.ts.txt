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
    const resourceIds = new WeakMap<object, number>();
    let nextResourceId = 1;
    const idFor = (resource: object) => {
      let id = resourceIds.get(resource);
      if (id === undefined) {
        id = nextResourceId++;
        resourceIds.set(resource, id);
      }
      return id;
    };
    const allocations: Array<{ kind: string; label: string; id: number }> = [];
    const uploads: Array<{ kind: string; id: number }> = [];
    const restorers: Array<() => void> = [];
    const intercept = (
      prototype: any,
      method: string,
      replacement: (original: (...args: any[]) => any, receiver: any, args: any[]) => any,
    ) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      if (descriptor === undefined || typeof descriptor.value !== "function") {
        throw new Error(`WebGPU instrumentation cannot intercept ${method}`);
      }
      Object.defineProperty(prototype, method, {
        ...descriptor,
        value: function (...args: any[]) {
          return replacement(descriptor.value, this, args);
        },
      });
      restorers.push(() => Object.defineProperty(prototype, method, descriptor));
    };
    intercept(GPUDevice.prototype, "createBuffer", (original, receiver, args) => {
      const resource = original.apply(receiver, args);
      const label = String(args[0]?.label ?? "");
      if (label.startsWith("forge3d-web-terrain-")) {
        allocations.push({ kind: "buffer", label, id: idFor(resource) });
      }
      return resource;
    });
    intercept(GPUDevice.prototype, "createTexture", (original, receiver, args) => {
      const resource = original.apply(receiver, args);
      const label = String(args[0]?.label ?? "");
      if (label === "forge3d-web-terrain-height-r32float") {
        allocations.push({ kind: "texture", label, id: idFor(resource) });
      }
      return resource;
    });
    intercept(GPUDevice.prototype, "createRenderPipeline", (original, receiver, args) => {
      const resource = original.apply(receiver, args);
      const label = String(args[0]?.label ?? "");
      if (label === "forge3d-web-terrain-pipeline") {
        allocations.push({ kind: "pipeline", label, id: idFor(resource) });
      }
      return resource;
    });
    intercept(GPUQueue.prototype, "writeBuffer", (original, receiver, args) => {
      if (resourceIds.has(args[0])) uploads.push({ kind: "buffer", id: idFor(args[0]) });
      return original.apply(receiver, args);
    });
    intercept(GPUQueue.prototype, "writeTexture", (original, receiver, args) => {
      if (resourceIds.has(args[0]?.texture)) {
        uploads.push({ kind: "texture", id: idFor(args[0].texture) });
      }
      return original.apply(receiver, args);
    });
    try {
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
    const terrainLabels = new Set([
      "forge3d-web-terrain-vertices",
      "forge3d-web-terrain-indices",
      "forge3d-web-terrain-height-r32float",
    ]);
    const terrainBefore = allocations
      .filter((entry) => terrainLabels.has(entry.label))
      .map((entry) => `${entry.kind}:${entry.label}:${entry.id}`);
    const uploadsBefore = uploads.map((entry) => `${entry.kind}:${entry.id}`);
    const pipelinesBefore = allocations.filter(
      (entry) => entry.kind === "pipeline",
    );
    const outdated = runtime.simulateSurfaceFailureForTesting(
      "outdated",
      false,
    );
    const renderedAfterReconfigure = runtime.render();
    const lost = runtime.simulateSurfaceFailureForTesting("lost", true);
    const terrainAfterRecovery = allocations
      .filter((entry) => terrainLabels.has(entry.label))
      .map((entry) => `${entry.kind}:${entry.label}:${entry.id}`);
    const uploadsAfterRecovery = uploads.map((entry) => `${entry.kind}:${entry.id}`);
    const pipelinesAfterRecovery = allocations.filter(
      (entry) => entry.kind === "pipeline",
    );
    const renderedAfterRecreate = runtime.render();
    let shaderCode;
    let shaderMessage;
    try {
      await runtime.simulateShaderCompilationFailureForTesting();
    } catch (error: any) {
      shaderCode = error.code;
      shaderMessage = error.message;
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
      shaderMessage,
      capabilities,
      terrainBefore,
      terrainAfterRecovery,
      uploadsBefore,
      uploadsAfterRecovery,
      pipelineBefore: pipelinesBefore.at(-1)?.id,
      pipelineAfterRecovery: pipelinesAfterRecovery.at(-1)?.id,
      pipelineCountBefore: pipelinesBefore.length,
      pipelineCountAfterRecovery: pipelinesAfterRecovery.length,
    };
    } finally {
      for (const restore of restorers.reverse()) restore();
    }
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
  expect(result.shaderMessage).toContain(
    "forge3d-web-diagnostic-invalid-shader/pipeline",
  );
  expect(result.terrainAfterRecovery).toEqual(result.terrainBefore);
  expect(result.uploadsAfterRecovery).toEqual(result.uploadsBefore);
  expect(result.pipelineAfterRecovery).not.toBe(result.pipelineBefore);
  expect(result.pipelineCountAfterRecovery).toBe(result.pipelineCountBefore + 1);
});

test("facade disposal detaches generated-WASM loss listener during screenshot", async ({
  page,
  request,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-clear.html");
  const routeId = `hold-device-loss-${Date.now()}`;
  const wasmUrl = `/tests/realm-fixture/runtime.wasm?id=${routeId}`;
  const resultPromise = page.evaluate(async (wasmUrl) => {
    const facade = await import("/src-ts/index.ts");
    const internals = await import("/src-ts/runtime-internals.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const createPromise = facade.Forge3DRuntime.create(canvas, {
      diagnostics: true,
      width: 64,
      height: 64,
      devicePixelRatio: 1,
      wasmUrl,
    });
    const coordinator = (globalThis as any)[
      Symbol.for("@forge3d/web.wasm-bridge-coordinator")
    ];
    const bridge = await coordinator.record.promise;
    const prototype: any = bridge.Forge3DRuntime.prototype;
    const originalRegister = prototype.registerDeviceLostCallback;
    const originalDispose = prototype.dispose;
    if (typeof originalRegister !== "function") {
      throw new Error("generated bridge is missing registerDeviceLostCallback");
    }
    let detachCount = 0;
    let nativeDisposeCount = 0;
    prototype.registerDeviceLostCallback = function (...args: any[]) {
      const detach = originalRegister.apply(this, args);
      return function (this: any, ...detachArgs: any[]) {
        detachCount += 1;
        return detach.apply(this, detachArgs);
      };
    };
    prototype.dispose = function (...args: any[]) {
      nativeDisposeCount += 1;
      return originalDispose.apply(this, args);
    };
    try {
      const runtime = await createPromise;
      let callbacks = 0;
      internals.setRuntimeDeviceLostHandler(runtime, () => {
        callbacks += 1;
      });
      internals.simulateRuntimeDeviceLossForTests(runtime);
      const screenshot = runtime.screenshot();
      runtime.dispose();
      const detachedSynchronously = detachCount;
      const callbacksSynchronously = callbacks;
      let screenshotCode;
      try {
        await screenshot;
      } catch (error: any) {
        screenshotCode = error.code;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const capabilities = runtime.getCapabilities();
      runtime.dispose();
      canvas.remove();
      return {
        detachedSynchronously,
        callbacksSynchronously,
        callbacks,
        screenshotCode,
        nativeDisposeCount,
        capabilities,
      };
    } finally {
      prototype.registerDeviceLostCallback = originalRegister;
      prototype.dispose = originalDispose;
    }
  }, wasmUrl);
  await expect.poll(async () => {
    const response = await request.get("/tests/realm-fixture/metrics");
    const metrics = await response.json();
    return metrics.held.includes(routeId);
  }).toBe(true);
  expect((await request.post(`/tests/realm-fixture/release?id=${routeId}`)).ok()).toBe(true);
  const result = await resultPromise;

  expect(result.detachedSynchronously).toBe(1);
  expect(result.callbacksSynchronously).toBe(0);
  expect(result.callbacks).toBe(0);
  expect(result.screenshotCode).toBe("RUNTIME_DISPOSED");
  expect(result.nativeDisposeCount).toBe(1);
  expect(result.capabilities.deviceState).toBe("disposed");
});

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
