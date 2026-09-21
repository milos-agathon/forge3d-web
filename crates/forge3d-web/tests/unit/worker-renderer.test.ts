import { afterEach, describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  CameraInput,
  Forge3DRuntimeCapabilities,
  SceneSnapshot,
  TerrainHeightmapInput,
} from "../../src-ts/index.js";
import { Forge3DMessageClient } from "../../src-ts/message-protocol.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import {
  Forge3DSession,
  setSessionRuntimeFactoryForTests,
} from "../../src-ts/session.js";
import type { SessionRuntimeLike } from "../../src-ts/session.js";
import {
  Forge3DWorkerRenderer,
  installForge3DWorkerHost,
} from "../../src-ts/worker-renderer.js";

const CAPABILITIES: Forge3DRuntimeCapabilities = {
  deviceState: "ready",
  maxTextureDimension2D: 4096,
  maxBufferSize: 1024 * 1024,
  surfaceFormat: "bgra8unorm",
};

class FakeRuntime implements SessionRuntimeLike {
  disposed = false;
  readonly terrains: TerrainHeightmapInput[] = [];
  readonly scenes: SceneSnapshot[] = [];
  readonly cameras: CameraInput[] = [];
  readonly resizes: unknown[] = [];
  renderCalls = 0;
  rgba = new Uint8Array([9, 8, 7, 6]);
  failNextSetScene = false;
  #loss: ((error: unknown) => void) | undefined;

  getCapabilities(): Forge3DRuntimeCapabilities {
    return CAPABILITIES;
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    this.terrains.push(terrain);
  }

  setScene(scene: SceneSnapshot): void {
    if (this.failNextSetScene) {
      this.failNextSetScene = false;
      throw new Forge3DError("INVALID_INPUT", "injected setScene failure");
    }
    this.scenes.push(scene);
  }

  setCamera(camera: CameraInput): void {
    this.cameras.push(camera);
  }

  setDeviceLostHandler(handler: ((error: unknown) => void) | undefined): void {
    this.#loss = handler;
  }

  resize(size: unknown): void {
    this.resizes.push(size);
  }

  render(): boolean {
    this.renderCalls += 1;
    return true;
  }

  screenshot(): Promise<Blob> {
    return Promise.resolve(new Blob(["png-bytes"], { type: "image/png" }));
  }

  readRgba(): Promise<Uint8Array> {
    return Promise.resolve(this.rgba);
  }

  dispose(): void {
    this.disposed = true;
  }
}

type CanvasListener = (event: Record<string, unknown>) => void;

class FakeStyle {
  readonly #properties = new Map<
    string,
    { value: string; priority: string }
  >();

  get length(): number {
    return this.#properties.size;
  }

  get touchAction(): string {
    return this.getPropertyValue("touch-action");
  }

  set touchAction(value: string) {
    if (value) {
      this.setProperty("touch-action", value);
    } else {
      this.removeProperty("touch-action");
    }
  }

  item(index: number): string {
    return [...this.#properties.keys()][index] ?? "";
  }

  getPropertyValue(property: string): string {
    return this.#properties.get(property)?.value ?? "";
  }

  getPropertyPriority(property: string): string {
    return this.#properties.get(property)?.priority ?? "";
  }

  setProperty(property: string, value: string, priority = ""): void {
    this.#properties.set(property, { value, priority });
  }

  removeProperty(property: string): string {
    const previous = this.getPropertyValue(property);
    this.#properties.delete(property);
    return previous;
  }
}

class FakeCanvas {
  readonly listeners = new Map<string, Set<CanvasListener>>();
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly captured = new Set<number>();
  readonly offscreen = { kind: "fake-offscreen" };
  clientHeight = 100;
  focusCalls = 0;

  addEventListener(type: string, listener: CanvasListener): void {
    const set = this.listeners.get(type) ?? new Set<CanvasListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: CanvasListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setPointerCapture(id: number): void {
    this.captured.add(id);
  }

  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }

  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }

  focus(): void {
    this.focusCalls += 1;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 100 };
  }

  transferControlToOffscreen(): unknown {
    return this.offscreen;
  }
}

interface FakeWorker {
  worker: {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
    removeEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
  };
  hostPort(): MessagePort;
  initMessages(): Array<Record<string, unknown>>;
  listenerCount(): number;
  emit(data: unknown): void;
}

function createFakeWorker(): FakeWorker {
  const hostListeners = new Set<(event: { data: unknown }) => void>();
  const inits: Array<Record<string, unknown>> = [];
  let hostPort: MessagePort | undefined;
  const worker = {
    postMessage(message: unknown): void {
      const init = message as {
        canvas: unknown;
        port: MessagePort;
        options: unknown;
      };
      inits.push(init as unknown as Record<string, unknown>);
      const bridge = new MessageChannel();
      hostPort = bridge.port1;
      init.port.addEventListener("message", (event) => {
        bridge.port1.postMessage(event.data);
      });
      bridge.port1.addEventListener("message", (event) => {
        init.port.postMessage(event.data);
      });
      init.port.start();
      bridge.port1.start();
      for (const listener of [...hostListeners]) {
        listener({
          data: {
            forge3d: 1,
            type: "init",
            canvas: init.canvas,
            port: bridge.port2,
            options: init.options,
          },
        });
      }
    },
    addEventListener(
      _type: "message",
      listener: (event: { data: unknown }) => void,
    ): void {
      hostListeners.add(listener);
    },
    removeEventListener(
      _type: "message",
      listener: (event: { data: unknown }) => void,
    ): void {
      hostListeners.delete(listener);
    },
  };
  return {
    worker,
    hostPort: () => {
      if (hostPort === undefined) {
        throw new Error("no init message posted");
      }
      return hostPort;
    },
    initMessages: () => inits,
    listenerCount: () => hostListeners.size,
    emit(data: unknown): void {
      for (const listener of [...hostListeners]) {
        listener({ data });
      }
    },
  };
}

let runtimes: FakeRuntime[] = [];
let hostDisposers: Array<() => void> = [];

function installRuntimeFactory(): void {
  setSessionRuntimeFactoryForTests(() =>
    Promise.resolve(new FakeRuntime()),
  );
}

function latestRuntime(): FakeRuntime {
  const runtime = runtimes[runtimes.length - 1];
  if (runtime === undefined) {
    throw new Error("no runtime");
  }
  return runtime;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function pointer(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    preventDefault() {},
    ...overrides,
  };
}

afterEach(() => {
  setSessionRuntimeFactoryForTests(undefined);
  vi.unstubAllGlobals();
  for (const dispose of hostDisposers) {
    dispose();
  }
  hostDisposers = [];
  runtimes = [];
});

describe("Forge3DWorkerRenderer", () => {
  it("transfers an OffscreenCanvas and port during init and waits for ready", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));

    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker },
    );

    const init = fake.initMessages()[0]!;
    expect(init["canvas"]).toBe(canvas.offscreen);
    expect(init["port"]).toBeInstanceOf(MessagePort);
    expect(renderer.disposed).toBe(false);
    expect(latestRuntime().disposed).toBe(false);
    renderer.dispose();
    await flush();
    expect(latestRuntime().disposed).toBe(true);
  });

  it("rejects canvases without transferControlToOffscreen", async () => {
    const canvas = {
      getAttribute: () => null,
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
    };
    await expect(
      Forge3DWorkerRenderer.create(canvas as unknown as HTMLCanvasElement, {
        worker: createFakeWorker().worker as unknown as Worker,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
  });

  it("drives scene, camera, resize, render, and outputs through the host", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      {
        worker: fake.worker as unknown as Worker,
        controls: false,
        resize: false,
      },
    );

    const scene = Forge3DScene.create();
    scene.addGroundPlane({
      name: "ground",
      size: [4, 4],
      color: [1, 1, 1, 1],
    });
    await renderer.setScene(scene);
    expect(latestRuntime().scenes).toHaveLength(1);

    await renderer.resize({ width: 8, height: 6, devicePixelRatio: 1 });
    expect(latestRuntime().resizes).toEqual([
      { width: 8, height: 6, devicePixelRatio: 1 },
    ]);

    expect(await renderer.render()).toBe(true);
    expect(latestRuntime().renderCalls).toBe(1);

    const shot = await renderer.screenshot();
    expect(shot).toBeInstanceOf(Blob);
    expect(await shot.text()).toBe("png-bytes");

    expect(Array.from(await renderer.readRgba())).toEqual([9, 8, 7, 6]);
    renderer.dispose();
  });

  it("produces the same state hash on main and host", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      {
        worker: fake.worker as unknown as Worker,
        controls: false,
      },
    );
    const hostClient = new Forge3DMessageClient(fake.hostPort());

    const empty = renderer.getDiagnostics().stateHash;
    const hostEmpty = await hostClient.call<{ stateHash: string }>(
      "diagnostics",
    );
    expect(hostEmpty.stateHash).toBe(empty);

    const scene = Forge3DScene.create();
    scene.addTerrain(
      { width: 2, height: 2, heights: new Float32Array([1, 2, 3, 4]) },
      { name: "terrain" },
    );
    await renderer.setScene(scene);
    await renderer.resize({ width: 4, height: 4, devicePixelRatio: 1 });
    await flush();

    const host = await hostClient.call<{ stateHash: string }>("diagnostics");
    expect(host.stateHash).toBe(renderer.getDiagnostics().stateHash);
    expect(latestRuntime().terrains).toHaveLength(1);
    expect(Array.from(latestRuntime().terrains[0]!.heights)).toEqual([
      1, 2, 3, 4,
    ]);
    renderer.dispose();
  });

  it("replays pointer, wheel, and keyboard input as canonical cameras", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      {
        worker: fake.worker as unknown as Worker,
        ariaLabel: "terrain view",
      },
    );

    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("aria-label")).toBe("terrain view");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    await flush();
    const initialCameras = latestRuntime().cameras.length;
    expect(initialCameras).toBe(1);

    canvas.dispatch("pointerdown", pointer({}));
    expect(canvas.focusCalls).toBe(1);
    canvas.dispatch(
      "pointermove",
      pointer({ clientX: 30, clientY: 10 }),
    );
    canvas.dispatch("pointerup", pointer({ buttons: 0 }));
    canvas.dispatch(
      "wheel",
      { deltaY: 120, deltaMode: 0, preventDefault() {} },
    );
    canvas.dispatch(
      "keydown",
      { key: "ArrowLeft", shiftKey: false, preventDefault() {} },
    );
    await flush();

    const cameras = latestRuntime().cameras;
    expect(cameras.length).toBeGreaterThanOrEqual(4);
    for (const camera of cameras) {
      expect(camera.position.every(Number.isFinite)).toBe(true);
      expect(camera.fovYDegrees).toBeGreaterThan(0);
    }
    expect(cameras.at(-1)).not.toEqual(cameras[0]);
    expect(renderer.getDiagnostics().activePointers).toBe(0);

    renderer.dispose();
    expect(canvas.getAttribute("role")).toBeNull();
    expect(canvas.getAttribute("aria-label")).toBeNull();
    expect(canvas.getAttribute("tabindex")).toBeNull();
    expect(canvas.style.touchAction).toBe("");
  });

  it("leaves no listeners or pointers after 30 cycles", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    for (let cycle = 0; cycle < 30; cycle += 1) {
      const dispose = installForge3DWorkerHost(fake.worker as never);
      const canvas = new FakeCanvas();
      const renderer = await Forge3DWorkerRenderer.create(
        canvas as unknown as HTMLCanvasElement,
        { worker: fake.worker as unknown as Worker },
      );
      canvas.dispatch("pointerdown", pointer({}));
      canvas.dispatch("pointermove", pointer({ clientX: 20, clientY: 12 }));
      const scene = Forge3DScene.create();
      scene.addOverlay({
        name: "hud",
        bounds: [0, 0, 4, 4],
        color: [0, 0, 0, 1],
      });
      await renderer.setScene(scene);
      await renderer.render();
      const diagnostics = renderer.getDiagnostics();
      expect(diagnostics.ownedListeners).toBe(9);
      renderer.dispose();
      await flush();
      expect(runtimes[cycle]!.disposed).toBe(true);
      dispose();
      expect(renderer.getDiagnostics().ownedListeners).toBe(0);
      expect(renderer.getDiagnostics().activePointers).toBe(0);
      expect(canvas.listenerCount()).toBe(0);
      expect(canvas.captured.size).toBe(0);
    }
    expect(runtimes).toHaveLength(30);
    await flush();
    expect(runtimes.every((runtime) => runtime.disposed)).toBe(true);
  });

  it("restores the prior committed scene when setScene fails", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    const first = Forge3DScene.create();
    first.addGroundPlane({
      name: "ground",
      size: [2, 2],
      color: [1, 1, 1, 1],
    });
    await renderer.setScene(first);
    const committedHash = renderer.getDiagnostics().stateHash;

    latestRuntime().failNextSetScene = true;
    const second = Forge3DScene.create();
    second.addOverlay({
      name: "hud",
      bounds: [0, 0, 4, 4],
      color: [1, 0, 0, 1],
    });
    await expect(renderer.setScene(second)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(renderer.getDiagnostics().stateHash).toBe(committedHash);

    const third = Forge3DScene.create();
    third.addGroundPlane({
      name: "ground2",
      size: [3, 3],
      color: [0, 1, 0, 1],
    });
    await renderer.setScene(third);
    expect(renderer.getDiagnostics().stateHash).not.toBe(committedHash);
    renderer.dispose();
  });

  it("hashes cyclic custom payloads deterministically", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    const payload: { name: string; self?: unknown } = { name: "loop" };
    payload.self = payload;
    const scene = Forge3DScene.create();
    scene.addNode({
      kind: "custom",
      name: "probe",
      layerType: "probe",
      payload,
    });
    await renderer.setScene(scene);
    const hash = renderer.getDiagnostics().stateHash;
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    const hostClient = new Forge3DMessageClient(fake.hostPort());
    const host = await hostClient.call<{ stateHash: string }>(
      "diagnostics",
    );
    expect(host.stateHash).toBe(hash);
    renderer.dispose();
  });

  it("disposes the active session when the host is torn down", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    const dispose = installForge3DWorkerHost(fake.worker as never);
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    expect(latestRuntime().disposed).toBe(false);
    dispose();
    await flush();
    expect(latestRuntime().disposed).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    renderer.dispose();
  });

  it("disposes the previous session when a second init arrives", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const first = await Forge3DWorkerRenderer.create(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    const firstRuntime = latestRuntime();
    const second = await Forge3DWorkerRenderer.create(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    await flush();
    expect(firstRuntime.disposed).toBe(true);
    expect(latestRuntime()).not.toBe(firstRuntime);
    expect(latestRuntime().disposed).toBe(false);
    first.dispose();
    second.dispose();
  });

  it("forwards ResizeObserver-driven auto resize to the host", async () => {
    const observers: Array<{
      observe(target: Element): void;
      disconnect(): void;
      fire(width: number, height: number): void;
    }> = [];
    class FakeResizeObserver {
      readonly #callback: ResizeObserverCallback;
      #target: Element | undefined;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
        observers.push(this);
      }
      observe(target: Element): void {
        this.#target = target;
      }
      disconnect(): void {
        this.#target = undefined;
      }
      fire(width: number, height: number): void {
        if (this.#target === undefined) {
          return;
        }
        const entry = {
          target: this.#target,
          contentRect: { width, height },
        } as unknown as ResizeObserverEntry;
        this.#callback([entry], this as unknown as ResizeObserver);
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    expect(renderer.getDiagnostics().activeObservers).toBe(1);
    await flush();
    expect(latestRuntime().resizes).toEqual([
      { width: 100, height: 100, devicePixelRatio: 1 },
    ]);
    observers[0]!.fire(60, 40);
    await flush();
    expect(latestRuntime().resizes.at(-1)).toEqual({
      width: 60,
      height: 40,
      devicePixelRatio: 1,
    });
    await renderer.resize({ width: 20, height: 10, devicePixelRatio: 1 });
    expect(latestRuntime().resizes.at(-1)).toEqual({
      width: 20,
      height: 10,
      devicePixelRatio: 1,
    });
    renderer.dispose();
    expect(renderer.getDiagnostics().activeObservers).toBe(0);
  });

  it("rejects operations after dispose", async () => {
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve(runtime);
    });
    const fake = createFakeWorker();
    hostDisposers.push(installForge3DWorkerHost(fake.worker as never));
    const canvas = new FakeCanvas();
    const renderer = await Forge3DWorkerRenderer.create(
      canvas as unknown as HTMLCanvasElement,
      { worker: fake.worker as unknown as Worker, controls: false },
    );
    renderer.dispose();
    expect(() => renderer.render()).toThrowError(
      expect.objectContaining({ code: "RUNTIME_DISPOSED" }) as never,
    );
    await expect(
      renderer.setScene(Forge3DScene.create()),
    ).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
    renderer.dispose();
  });
});
