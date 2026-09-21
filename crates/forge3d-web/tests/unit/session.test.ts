import { afterEach, describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  CameraInput,
  Forge3DRuntimeCapabilities,
  Forge3DRuntimeOptions,
  Forge3DSessionOptions,
  MemoryReport,
  RenderStats,
  ResizeInput,
  SceneSnapshot,
  TerrainHeightmapInput,
} from "../../src-ts/index.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import {
  Forge3DSession,
  setSessionRuntimeFactoryForTests,
} from "../../src-ts/session.js";
import type { SessionRuntimeLike } from "../../src-ts/session.js";

const BASE_CAPABILITIES: Forge3DRuntimeCapabilities = {
  deviceState: "ready",
  maxTextureDimension2D: 8192,
  maxBufferSize: 1024 * 1024,
  surfaceFormat: "bgra8unorm",
};

class FakeRuntime implements SessionRuntimeLike {
  static activeCount = 0;
  static listenerCount = 0;
  static instances: FakeRuntime[] = [];

  disposed = false;
  renderResult = true;
  renderCalls = 0;
  disposeCalls = 0;
  failGetCapabilities = false;
  failSetScene = false;
  failSetDeviceLostHandler = false;
  readonly terrains: TerrainHeightmapInput[] = [];
  readonly scenes: SceneSnapshot[] = [];
  readonly resizes: ResizeInput[] = [];
  readonly cameras: CameraInput[] = [];
  screenshotCalls = 0;
  screenshotResult: Promise<Blob> | undefined;
  rgba = new Uint8Array([1, 2, 3, 4]);
  stats: unknown;
  memory: unknown;
  failGetRenderStats = false;
  #capabilities: Forge3DRuntimeCapabilities;
  #loss: ((error: unknown) => void) | undefined;

  constructor(capabilities: Forge3DRuntimeCapabilities) {
    this.#capabilities = capabilities;
    FakeRuntime.activeCount += 1;
    FakeRuntime.instances.push(this);
  }

  getCapabilities(): Forge3DRuntimeCapabilities {
    if (this.failGetCapabilities) {
      throw new Forge3DError("INTERNAL_ERROR", "capabilities failed");
    }
    return this.#capabilities;
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    this.terrains.push(terrain);
  }

  setScene(scene: SceneSnapshot): void {
    if (this.failSetScene) {
      this.failSetScene = false;
      throw new Forge3DError("INTERNAL_ERROR", "scene apply failed");
    }
    this.scenes.push(scene);
  }

  setCamera(camera: CameraInput): void {
    this.cameras.push(camera);
  }

  setDeviceLostHandler(
    handler: ((error: unknown) => void) | undefined,
  ): void {
    if (this.failSetDeviceLostHandler) {
      throw new Forge3DError("INTERNAL_ERROR", "loss attach failed");
    }
    FakeRuntime.listenerCount +=
      (handler === undefined ? 0 : 1) - (this.#loss === undefined ? 0 : 1);
    this.#loss = handler;
  }

  resize(size: ResizeInput): void {
    this.resizes.push({ ...size });
  }

  render(): boolean {
    this.renderCalls += 1;
    return this.renderResult;
  }

  screenshot(): Promise<Blob> {
    this.screenshotCalls += 1;
    return this.screenshotResult ?? Promise.resolve(new Blob(["png"]));
  }

  readRgba(): Promise<Uint8Array> {
    return Promise.resolve(this.rgba);
  }

  getRenderStats(): RenderStats {
    if (this.failGetRenderStats) {
      throw new Forge3DError("INTERNAL_ERROR", "stats failed");
    }
    return this.stats as RenderStats;
  }

  getMemoryReport(): MemoryReport {
    return this.memory as MemoryReport;
  }

  lose(error: unknown = new Forge3DError("DEVICE_LOST", "lost")): void {
    this.#loss?.(error);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeCalls += 1;
    FakeRuntime.activeCount -= 1;
  }
}

let nextCapabilities: Forge3DRuntimeCapabilities = BASE_CAPABILITIES;
let factoryCalls: Array<{
  canvas: unknown;
  options: Forge3DRuntimeOptions;
}> = [];

function installFactory(): void {
  setSessionRuntimeFactoryForTests((canvas, options) => {
    factoryCalls.push({ canvas, options });
    return Promise.resolve(new FakeRuntime(nextCapabilities));
  });
}

function latest(): FakeRuntime {
  const runtime = FakeRuntime.instances[FakeRuntime.instances.length - 1];
  if (runtime === undefined) {
    throw new Error("no fake runtime");
  }
  return runtime;
}

function terrain(): TerrainHeightmapInput {
  return { width: 3, height: 3, heights: new Float32Array(9) };
}

afterEach(() => {
  setSessionRuntimeFactoryForTests(undefined);
  FakeRuntime.activeCount = 0;
  FakeRuntime.listenerCount = 0;
  FakeRuntime.instances = [];
  nextCapabilities = BASE_CAPABILITIES;
  factoryCalls = [];
});

describe("Forge3DSession", () => {
  it("normalizes capabilities and config on creation", async () => {
    installFactory();
    nextCapabilities = {
      deviceState: "ready",
      maxTextureDimension2D: 4096,
      maxBufferSize: 256,
      surfaceFormat: "rgba8unorm-srgb",
      features: ["zeta", "alpha", "zeta"],
      surfaceFormats: ["rgba8unorm-srgb", "bgra8unorm", "bgra8unorm"],
    };
    const canvas = {} as OffscreenCanvas;
    const session = await Forge3DSession.create(canvas, {
      renderer: "toon-viz",
      runtime: { width: 4 },
    });

    expect(session.status).toBe("ready");
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]!.canvas).toBe(canvas);
    expect(factoryCalls[0]!.options).toEqual({
      width: 4,
      quality: "high",
      memoryBudgetBytes: 512 * 1024 * 1024,
      overflowPolicy: "downscale",
      timestampMode: "auto",
    });
    expect(session.getConfig().toJSON().shading.brdf).toBe("toon");

    const capabilities = session.getCapabilities();
    expect(capabilities).toEqual({
      deviceState: "ready",
      maxTextureDimension2D: 4096,
      maxBufferSize: 256,
      surfaceFormat: "rgba8unorm-srgb",
      adapterInfo: {
        name: "",
        vendor: "",
        architecture: "",
        device: "",
        description: "",
        backend: "browser-webgpu",
        deviceType: "unknown",
      },
      isFallbackAdapter: false,
      features: ["alpha", "zeta"],
      limits: {},
      surfaceFormats: ["bgra8unorm", "rgba8unorm-srgb"],
      preferredCanvasFormat: "rgba8unorm-srgb",
      timestampQuery: false,
      timingMode: "cpu",
      effectiveQuality: "high",
      offscreenCanvas: false,
      workers: false,
      sharedArrayBuffer: false,
      fileSystemAccess: false,
      opfs: false,
    });

    capabilities.features.push("mutated");
    capabilities.limits["x"] = 1;
    expect(session.getCapabilities().features).toEqual(["alpha", "zeta"]);
    expect(session.getCapabilities().limits).toEqual({});

    session.dispose();
  });

  it("reports gpu timing mode when timestamps are available", async () => {
    installFactory();
    nextCapabilities = {
      ...BASE_CAPABILITIES,
      timestampQuery: true,
    };
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    expect(session.getCapabilities().timingMode).toBe("gpu-timestamp");
    session.dispose();

    const disabled = await Forge3DSession.create({} as OffscreenCanvas, {
      renderer: { timestampMode: "disabled" },
    });
    expect(disabled.getCapabilities().timingMode).toBe("cpu");
    disabled.dispose();
  });

  it("rejects oversized scenes before mutating committed state", async () => {
    installFactory();
    const options: Forge3DSessionOptions = {
      renderer: {
        memoryBudgetBytes: 200,
        overflowPolicy: "reject",
      },
    };
    const session = await Forge3DSession.create(
      {} as OffscreenCanvas,
      options,
    );

    const small = Forge3DScene.create();
    small.addGroundPlane({
      name: "ground",
      size: [4, 4],
      color: [1, 1, 1, 1],
    });
    session.setScene(small);
    expect(session.getMemoryReport().currentBytes).toBe(168);

    const oversized = Forge3DScene.create();
    oversized.addTerrain(terrain(), { name: "terrain" });
    try {
      session.setScene(oversized);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Forge3DError).code).toBe("RESOURCE_LIMIT_EXCEEDED");
    }

    expect(session.getMemoryReport().currentBytes).toBe(168);
    expect(session.getScene()!.snapshot().nodes).toHaveLength(1);
    expect(latest().scenes).toHaveLength(1);
    expect(session.render()).toBe(true);
    session.dispose();
  });

  it("downscales scene admission deterministically", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas, {
      renderer: {
        quality: "ultra",
        memoryBudgetBytes: 300,
        overflowPolicy: "downscale",
      },
    });
    const scene = Forge3DScene.create();
    scene.addTerrain(terrain(), { name: "terrain" });
    session.setScene(scene);

    const report = session.getMemoryReport();
    expect(report.currentBytes).toBe(234);
    expect(report.downgrades).toEqual([
      {
        requested: "ultra",
        effective: "high",
        requestedBytes: 312,
        admittedBytes: 234,
      },
    ]);
    expect(session.getCapabilities().effectiveQuality).toBe("high");
    session.dispose();
  });

  it("applies terrain nodes and committed snapshots to the runtime", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const runtime = latest();

    const scene = Forge3DScene.create();
    const heights = new Float32Array([1, 2, 3, 4]);
    scene.addTerrain(
      { width: 2, height: 2, heights },
      { name: "terrain" },
    );
    scene.addOverlay({
      name: "hud",
      bounds: [0, 0, 10, 10],
      color: [0, 0, 0, 1],
    });
    session.setScene(scene);

    expect(runtime.terrains).toHaveLength(1);
    expect(runtime.terrains[0]!.heights).not.toBe(heights);
    expect(Array.from(runtime.terrains[0]!.heights)).toEqual([1, 2, 3, 4]);
    expect(runtime.scenes).toHaveLength(1);
    const committed = runtime.scenes[0]!;
    expect(committed.revision).toBe(scene.revision);
    expect(committed.nodes.map((node) => node.node.kind)).toEqual([
      "terrain",
      "overlay",
    ]);

    heights[0] = 99;
    expect(runtime.terrains[0]!.heights[0]).toBe(1);

    session.dispose();
  });

  it("produces plan-driven stats and only counts submitted frames", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const runtime = latest();

    const scene = Forge3DScene.create();
    scene.addGroundPlane({
      name: "ground",
      size: [4, 4],
      color: [1, 1, 1, 1],
    });
    scene.addPass({
      name: "post",
      kind: "render",
      reads: ["color"],
    });
    session.setScene(scene);

    expect(session.render()).toBe(true);
    const stats = session.getRenderStats();
    expect(stats.frameIndex).toBe(0);
    expect(stats.drawCalls).toBe(2);
    expect(stats.triangles).toBe(2);
    expect(stats.passes.map((pass) => pass.name)).toEqual([
      "ground-plane",
      "post",
    ]);
    for (const pass of stats.passes) {
      expect(pass.timing).toBe("cpu");
      expect(Number.isFinite(pass.milliseconds)).toBe(true);
      expect(pass.milliseconds).toBeGreaterThanOrEqual(0);
    }
    expect(
      stats.passes[0]!.milliseconds,
    ).toBeCloseTo(stats.passes[1]!.milliseconds, 12);

    stats.passes.push({
      name: "mutated",
      milliseconds: 1,
      timing: "cpu",
    });
    expect(session.getRenderStats().passes).toHaveLength(2);

    runtime.renderResult = false;
    expect(session.render()).toBe(false);
    expect(session.getRenderStats().frameIndex).toBe(0);

    runtime.renderResult = true;
    scene.addOverlay({
      name: "hud",
      bounds: [0, 0, 10, 10],
      color: [0, 0, 0, 1],
    });
    expect(session.render()).toBe(true);
    expect(runtime.scenes).toHaveLength(2);
    expect(session.getRenderStats().frameIndex).toBe(1);
    expect(session.getRenderStats().drawCalls).toBe(3);
    expect(session.getRenderStats().triangles).toBe(4);
    session.dispose();
  });

  it("replays the exact committed snapshot after device loss", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas, {
      recovery: { deviceLoss: "once" },
    });
    const first = latest();

    const scene = Forge3DScene.create();
    scene.addTerrain(terrain(), { name: "terrain" });
    session.setScene(scene);
    const committed = first.scenes[0]!;

    first.lose(new Forge3DError("DEVICE_LOST", "gpu gone"));
    expect(session.status).toBe("recovering");
    expect(first.disposed).toBe(true);
    expect(session.render.bind(session)).toThrowError(Forge3DError);

    await session.whenReady();
    expect(session.status).toBe("ready");
    expect(FakeRuntime.instances).toHaveLength(2);
    const replacement = latest();
    expect(replacement).not.toBe(first);
    expect(replacement.scenes).toHaveLength(1);
    expect(replacement.scenes[0]).toEqual(committed);
    expect(replacement.terrains).toHaveLength(1);

    scene.setVisible(0, false);
    expect(replacement.scenes).toHaveLength(1);
    expect(session.render()).toBe(true);
    expect(replacement.scenes).toHaveLength(2);

    session.dispose();
    expect(FakeRuntime.activeCount).toBe(0);
    expect(FakeRuntime.listenerCount).toBe(0);
  });

  it("fails with retained DEVICE_LOST when recovery is disabled", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas, {
      recovery: { deviceLoss: "none" },
    });
    const runtime = latest();
    const ready = session.whenReady();
    void ready.catch(() => undefined);
    runtime.lose(new Forge3DError("DEVICE_LOST", "gpu gone"));

    expect(session.status).toBe("failed");
    await expect(session.whenReady()).rejects.toMatchObject({
      code: "DEVICE_LOST",
    });
    for (const operation of [
      () => session.render(),
      () => session.setScene(Forge3DScene.create()),
      () => session.resize({ width: 1, height: 1, devicePixelRatio: 1 }),
      () => session.screenshot(),
    ]) {
      try {
        operation();
        throw new Error("expected DEVICE_LOST");
      } catch (error) {
        expect((error as Forge3DError).code).toBe("DEVICE_LOST");
      }
    }
    expect(session.getCapabilities().deviceState).toBe("lost");
    session.dispose();
    expect(session.status).toBe("disposed");
    expect(runtime.disposed).toBe(true);
  });

  it("fails after a second loss even with recovery once", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas, {
      recovery: { deviceLoss: "once" },
    });
    latest().lose();
    await session.whenReady();
    expect(session.status).toBe("ready");

    latest().lose();
    await expect(session.whenReady()).rejects.toMatchObject({
      code: "DEVICE_LOST",
    });
    expect(session.status).toBe("failed");
    expect(() => session.render()).toThrowError(
      expect.objectContaining({ code: "DEVICE_LOST" }) as never,
    );
    session.dispose();
  });

  it("delegates resize and screenshot to the runtime", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const runtime = latest();
    runtime.screenshotResult = Promise.resolve(new Blob(["frame"]));

    const size = { width: 10, height: 8, devicePixelRatio: 2 };
    session.resize(size);
    expect(runtime.resizes).toEqual([size]);
    expect(() =>
      session.resize({ width: 0, height: 1, devicePixelRatio: 1 }),
    ).toThrowError(Forge3DError);

    const blob = await session.screenshot();
    expect(blob).toBeInstanceOf(Blob);
    expect(runtime.screenshotCalls).toBe(1);
    session.dispose();
  });

  it("survives 30 create/set/render/loss/dispose cycles with no leaks", async () => {
    installFactory();
    let peakBytes = 0;
    for (let cycle = 0; cycle < 30; cycle += 1) {
      const session = await Forge3DSession.create({} as OffscreenCanvas, {
        recovery: { deviceLoss: "once" },
      });
      const scene = Forge3DScene.create();
      scene.addOverlay({
        name: `hud-${cycle}`,
        bounds: [0, 0, 10, 10],
        color: [0, 0, 0, 1],
      });
      session.setScene(scene);
      expect(session.render()).toBe(true);

      latest().lose();
      await session.whenReady();
      expect(session.render()).toBe(true);
      peakBytes = Math.max(peakBytes, session.getMemoryReport().peakBytes);
      session.dispose();
      session.dispose();

      const report = session.getMemoryReport();
      expect(report.currentBytes).toBe(0);
      expect(report.allocationCount).toBe(0);
      expect(report.peakBytes).toBeGreaterThan(0);
      for (const bytes of Object.values(report.categories)) {
        expect(bytes).toBe(0);
      }
      expect(session.disposed).toBe(true);
      expect(() => session.render()).toThrowError(
        expect.objectContaining({ code: "RUNTIME_DISPOSED" }) as never,
      );
    }
    expect(peakBytes).toBe(144);
    expect(FakeRuntime.activeCount).toBe(0);
    expect(FakeRuntime.listenerCount).toBe(0);
    expect(FakeRuntime.instances.every((runtime) => runtime.disposed)).toBe(
      true,
    );
  });

  it("restores the previous committed scene when reapplication fails", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const runtime = latest();

    const first = Forge3DScene.create();
    first.addTerrain(terrain(), { name: "terrain-a" });
    session.setScene(first);
    const committedSnapshot = runtime.scenes[0]!;
    expect(runtime.terrains).toHaveLength(1);

    const second = Forge3DScene.create();
    second.addTerrain(
      { width: 2, height: 2, heights: new Float32Array(4) },
      { name: "terrain-b" },
    );
    runtime.failSetScene = true;
    try {
      session.setScene(second);
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Forge3DError).code).toBe("INTERNAL_ERROR");
    }

    expect(runtime.terrains).toHaveLength(3);
    expect(runtime.scenes).toHaveLength(2);
    expect(runtime.scenes[1]).toEqual(committedSnapshot);
    const restored = session.getScene()!;
    expect(restored.snapshot().nodes).toHaveLength(1);
    expect(
      restored.snapshot().nodes[0]!.node.kind === "terrain"
        ? restored.snapshot().nodes[0]!.node.name
        : "",
    ).toBe("terrain-a");
    expect(session.getMemoryReport().currentBytes).toBe(312);
    session.dispose();
  });

  it("disposes the runtime when initialization fails after assignment", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime(BASE_CAPABILITIES);
      runtime.failGetCapabilities = true;
      return Promise.resolve(runtime);
    });
    await expect(
      Forge3DSession.create({} as OffscreenCanvas),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(latest().disposed).toBe(true);
    expect(FakeRuntime.activeCount).toBe(0);
    expect(FakeRuntime.listenerCount).toBe(0);
  });

  it("detaches and disposes a replacement when recovery replay fails", async () => {
    let created = 0;
    setSessionRuntimeFactoryForTests(() => {
      created += 1;
      const runtime = new FakeRuntime(BASE_CAPABILITIES);
      runtime.failSetDeviceLostHandler = created === 2;
      return Promise.resolve(runtime);
    });
    const session = await Forge3DSession.create({} as OffscreenCanvas, {
      recovery: { deviceLoss: "once" },
    });
    latest().lose();
    await expect(session.whenReady()).rejects.toMatchObject({
      code: "DEVICE_LOST",
    });
    expect(session.status).toBe("failed");
    expect(FakeRuntime.instances).toHaveLength(2);
    expect(FakeRuntime.instances.every((runtime) => runtime.disposed)).toBe(
      true,
    );
    expect(FakeRuntime.activeCount).toBe(0);
    expect(FakeRuntime.listenerCount).toBe(0);
    session.dispose();
  });

  it("delegates and replays the camera across recovery", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas, {
      recovery: { deviceLoss: "once" },
    });
    const camera: CameraInput = {
      position: [0, 1, 5],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 45,
      near: 0.1,
      far: 100,
    };
    session.setCamera(camera);
    expect(latest().cameras).toHaveLength(1);
    expect(latest().cameras[0]).toEqual(camera);
    expect(latest().cameras[0]).not.toBe(camera);

    latest().lose();
    await session.whenReady();
    const replacement = latest();
    expect(replacement.cameras).toHaveLength(1);
    expect(replacement.cameras[0]).toEqual(camera);

    camera.position[0] = 99;
    expect(replacement.cameras[0]!.position[0]).toBe(0);
    session.dispose();
  });

  it("validates camera input and rejects unsupported readback", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    for (const bad of [
      { position: [0, Number.NaN, 0] },
      { up: [0, 0, 0] },
      { fovYDegrees: 190 },
      { near: -1 },
      { near: 10, far: 1 },
    ]) {
      const camera = {
        position: [0, 0, 5],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fovYDegrees: 45,
        near: 0.1,
        far: 100,
        ...bad,
      } as CameraInput;
      expect(() => session.setCamera(camera)).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT" }) as never,
      );
    }

    const pixels = await session.readRgba();
    expect(Array.from(pixels)).toEqual([1, 2, 3, 4]);

    const runtime = latest() as unknown as { readRgba?: unknown };
    runtime.readRgba = undefined;
    expect(() => session.readRgba()).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_FEATURE" }) as never,
    );
    session.dispose();
  });

  it("uses validated native render stats after a successful render", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const runtime = latest();
    runtime.stats = {
      frameIndex: 7,
      frameTimeMs: 2.5,
      drawCalls: 4,
      triangles: 12,
      passes: [
        { name: "terrain", milliseconds: 2, timing: "gpu-timestamp" },
        { name: "overlay", milliseconds: 0.5, timing: "gpu-timestamp" },
      ],
    };

    expect(session.render()).toBe(true);
    const stats = session.getRenderStats();
    expect(stats).toEqual(runtime.stats);
    expect(stats.passes[0]!.timing).toBe("gpu-timestamp");

    stats.passes.length = 0;
    expect(session.getRenderStats().passes).toHaveLength(2);
    session.dispose();
  });

  it("falls back to CPU stats when native reports are absent or malformed", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const runtime = latest();

    const scene = Forge3DScene.create();
    scene.addGroundPlane({
      name: "ground",
      size: [4, 4],
      color: [1, 1, 1, 1],
    });
    session.setScene(scene);

    for (const malformed of [
      {
        frameIndex: -1,
        frameTimeMs: 1,
        drawCalls: 1,
        triangles: 2,
        passes: [],
      },
      {
        frameIndex: 0,
        frameTimeMs: Number.NaN,
        drawCalls: 1,
        triangles: 2,
        passes: [],
      },
      {
        frameIndex: 0,
        frameTimeMs: 1,
        drawCalls: 1,
        triangles: 2,
        passes: [{ name: 1 }],
      },
    ]) {
      runtime.stats = malformed;
      expect(session.render()).toBe(true);
      const stats = session.getRenderStats();
      expect(stats.passes.map((pass) => pass.name)).toEqual(["ground-plane"]);
      expect(stats.passes[0]!.timing).toBe("cpu");
    }

    runtime.failGetRenderStats = true;
    expect(session.render()).toBe(true);
    expect(session.getRenderStats().passes[0]!.timing).toBe("cpu");
    runtime.failGetRenderStats = false;

    runtime.stats = undefined;
    expect(session.render()).toBe(true);
    expect(session.getRenderStats().passes[0]!.timing).toBe("cpu");
    session.dispose();
  });

  it("reports platform capability booleans", async () => {
    installFactory();
    const session = await Forge3DSession.create({} as OffscreenCanvas);
    const capabilities = session.getCapabilities();
    expect(capabilities.offscreenCanvas).toBe(false);
    expect(capabilities.workers).toBe(false);
    expect(capabilities.sharedArrayBuffer).toBe(false);
    expect(capabilities.fileSystemAccess).toBe(false);
    expect(capabilities.opfs).toBe(false);

    withGlobal("OffscreenCanvas", class {}, () => {
      expect(session.getCapabilities().offscreenCanvas).toBe(true);
    });
    withGlobal("Worker", class {}, () => {
      expect(session.getCapabilities().workers).toBe(true);
    });
    withGlobal("crossOriginIsolated", true, () => {
      expect(session.getCapabilities().sharedArrayBuffer).toBe(true);
      withGlobal("SharedArrayBuffer", undefined, () => {
        expect(session.getCapabilities().sharedArrayBuffer).toBe(false);
      });
    });
    withGlobal(
      "showSaveFilePicker",
      () => undefined,
      () => {
        expect(session.getCapabilities().fileSystemAccess).toBe(true);
      },
    );
    withGlobal(
      "navigator",
      { storage: { getDirectory: () => undefined } },
      () => {
        expect(session.getCapabilities().opfs).toBe(true);
      },
    );
    session.dispose();
  });
});

function withGlobal(name: string, value: unknown, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    if (descriptor === undefined) {
      delete (globalThis as Record<string, unknown>)[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
}
