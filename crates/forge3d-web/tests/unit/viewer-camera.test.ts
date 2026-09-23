import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CameraInput,
  Forge3DError,
  type Forge3DRuntimeCapabilities,
  type ResizeInput,
  type TerrainHeightmapInput,
} from "../../src-ts/index.js";
import { Forge3DSession, setSessionRuntimeFactoryForTests } from "../../src-ts/session.js";
import { Forge3DViewer, setViewerRuntimeFactoryForTests } from "../../src-ts/viewer.js";

class CameraRuntime {
  disposed = false;
  width = 64;
  height = 48;
  readonly cameras: CameraInput[] = [];
  renderError: Forge3DError | undefined;
  lossHandler: ((error: Forge3DError) => void) | undefined;

  getCapabilities(): Forge3DRuntimeCapabilities {
    return {
      deviceState: this.disposed ? "disposed" : "ready",
      maxTextureDimension2D: 4096,
      maxBufferSize: 1_000_000_000,
      surfaceFormat: "bgra8unorm",
    };
  }

  setDeviceLostHandler(handler: ((error: Forge3DError) => void) | undefined): void {
    this.lossHandler = handler;
  }

  lose(error: Forge3DError): void {
    this.lossHandler?.(error);
  }

  setTerrain(_terrain: TerrainHeightmapInput): void {}

  async setTerrainFromSource(): Promise<void> {}

  setCamera(camera: CameraInput): void {
    this.cameras.push(structuredClone(camera));
  }

  resize(size: ResizeInput): void {
    this.width = size.width;
    this.height = size.height;
  }

  render(): boolean {
    if (this.renderError !== undefined) {
      const error = this.renderError;
      this.renderError = undefined;
      throw error;
    }
    return true;
  }

  screenshot(): Promise<Blob> {
    return Promise.resolve(new Blob());
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe("Forge3DViewer camera API (W05)", () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("window", Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  });

  afterEach(() => {
    setViewerRuntimeFactoryForTests(undefined);
    vi.unstubAllGlobals();
  });

  async function create(runtimes: CameraRuntime[], options = {}): Promise<Forge3DViewer> {
    let index = 0;
    setViewerRuntimeFactoryForTests({ create: async () => runtimes[index++] as CameraRuntime });
    return Forge3DViewer.create({} as HTMLCanvasElement, { controls: false, resize: false, ...options });
  }

  it("sets typed cameras including orthographic projection", async () => {
    const runtime = new CameraRuntime();
    const viewer = await create([runtime]);
    const camera: CameraInput = {
      position: [3, 4, 5],
      target: [0, 0.5, 0],
      up: [0, 2, 0],
      fovYDegrees: 40,
      near: 0.2,
      far: 50,
      projection: "orthographic",
      orthographicHeight: 6,
    };
    viewer.setCamera(camera);
    const sent = runtime.cameras.at(-1)!;
    expect(sent.projection).toBe("orthographic");
    expect(sent.orthographicHeight).toBe(6);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(sent.position[axis]).toBeCloseTo(camera.position[axis]!, 9);
      expect(sent.target[axis]).toBeCloseTo(camera.target[axis]!, 9);
    }
    expect(viewer.getCamera()).toEqual(sent);
    viewer.setCamera({ ...camera, projection: "perspective", orthographicHeight: undefined } as CameraInput);
    expect(runtime.cameras.at(-1)!.projection).toBeUndefined();
    expect(() => viewer.setCamera({ ...camera, up: [1, 0, 0] })).toThrow(/Y-up/);
    expect(() => viewer.setCamera({ ...camera, orthographicHeight: -1 })).toThrow(/orthographicHeight/);
    viewer.dispose();
  });

  it("switches to fly mode continuously and replays recorded input", async () => {
    const runtime = new CameraRuntime();
    const viewer = await create([runtime]);
    const orbitCamera = viewer.getCamera();
    viewer.startCameraRecording();
    viewer.setCameraMode("fly");
    expect(viewer.getCameraMode()).toBe("fly");
    const flyCamera = viewer.getCamera();
    for (let axis = 0; axis < 3; axis += 1) {
      expect(flyCamera.position[axis]).toBeCloseTo(orbitCamera.position[axis]!, 9);
    }
    viewer.replayCameraInput([
      { type: "look", deltaYawDegrees: 15, deltaPitchDegrees: -5 },
      { type: "move", forward: 1, right: 0.5, up: 0 },
    ]);
    const moved = viewer.getCamera();
    expect(runtime.cameras.at(-1)).toEqual(moved);
    const events = viewer.stopCameraRecording();
    expect(events.map((event) => event.type)).toEqual(["mode", "look", "move"]);
    const view = viewer.getFlyView();
    viewer.setFlyView({ ...view, position: [0, 9, 0] });
    expect(viewer.getCamera().position).toEqual([0, 9, 0]);
    viewer.resetView();
    expect(viewer.getFlyView().position).not.toEqual([0, 9, 0]);

    const other = await create([new CameraRuntime()]);
    other.replayCameraInput(events);
    expect(other.getCamera()).toEqual(moved);
    viewer.dispose();
    other.dispose();
  });

  it("replays the identical camera after device loss", async () => {
    const first = new CameraRuntime();
    const second = new CameraRuntime();
    const viewer = await create([first, second]);
    viewer.setCamera({
      position: [2, 3, 4],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 55,
      near: 0.1,
      far: 20,
      projection: "orthographic",
      orthographicHeight: 3,
    });
    viewer.setCameraMode("fly");
    const before = viewer.getCamera();
    first.lose(new Forge3DError("DEVICE_LOST", "test"));
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(second.cameras.at(-1)).toEqual(before);
    expect(viewer.getCamera()).toEqual(before);
    viewer.dispose();
  });

  it("drives keyboard fly movement through the scheduler frame hook", async () => {
    const runtime = new CameraRuntime();
    const canvas = new FakeCanvas();
    setViewerRuntimeFactoryForTests({ create: async () => runtime });
    const live = await Forge3DViewer.create(canvas as unknown as HTMLCanvasElement, {
      resize: false,
      controls: { mode: "fly", fly: { moveSpeed: 10 } },
    });
    expect(live.getCameraMode()).toBe("fly");
    const start = live.getFlyView().position;
    frames.splice(0).forEach((frame) => frame(0));
    canvas.dispatchEvent(keyEvent("keydown", "KeyW"));
    frames.splice(0).forEach((frame) => frame(1000));
    frames.splice(0).forEach((frame) => frame(1050));
    const moved = live.getFlyView().position;
    const distance = Math.hypot(moved[0] - start[0], moved[1] - start[1], moved[2] - start[2]);
    expect(distance).toBeCloseTo(10 * 0.05, 9);
    expect(runtime.cameras.at(-1)!.position).toEqual(moved);
    canvas.dispatchEvent(keyEvent("keyup", "KeyW"));
    frames.splice(0).forEach((frame) => frame(1100));
    expect(frames).toHaveLength(0);
    expect(live.getDiagnostics().ownedAnimationFrameCount).toBe(0);
    live.dispose();
  });
});

describe("Forge3DSession camera", () => {
  afterEach(() => setSessionRuntimeFactoryForTests(undefined));

  it("validates, stores and returns orthographic cameras", async () => {
    const cameras: CameraInput[] = [];
    setSessionRuntimeFactoryForTests(
      async () =>
        ({
          disposed: false,
          width: 8,
          height: 8,
          getCapabilities: () => ({ deviceState: "ready", maxTextureDimension2D: 4096, maxBufferSize: 1 << 30, surfaceFormat: "bgra8unorm" }),
          setCamera: (camera: CameraInput) => cameras.push(camera),
          resize: () => {},
          render: () => true,
          screenshot: async () => new Blob(),
          dispose: () => {},
        }) as never,
    );
    const session = await Forge3DSession.create({} as HTMLCanvasElement);
    expect(session.getCamera()).toBeUndefined();
    const camera: CameraInput = {
      position: [0, 5, 5],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 45,
      near: 0.1,
      far: 100,
      projection: "orthographic",
      orthographicHeight: 10,
    };
    session.setCamera(camera);
    expect(cameras.at(-1)).toEqual(camera);
    expect(session.getCamera()).toEqual(camera);
    expect(session.getCamera()).not.toBe(cameras.at(-1));
    expect(() => session.setCamera({ ...camera, projection: "orthographic", orthographicHeight: undefined } as CameraInput)).toThrow(
      /orthographicHeight/,
    );
    expect(() => session.setCamera({ ...camera, position: [0, 5, 0], orthographicHeight: 10 })).toThrow(/colinear/);
    session.dispose();
  });
});

class FakeCanvas extends EventTarget {
  readonly style = {
    length: 0,
    item: () => "",
    getPropertyValue: () => "",
    getPropertyPriority: () => "",
    setProperty: () => {},
    removeProperty: () => "",
  };
  readonly #attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  setPointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  releasePointerCapture(): void {}
  focus(): void {}
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, width: 64, height: 48, top: 0, right: 64, bottom: 48, left: 0, toJSON: () => ({}) };
  }
}

function keyEvent(type: string, code: string): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    key: { value: code },
    repeat: { value: false },
    shiftKey: { value: false },
  });
  return event;
}

