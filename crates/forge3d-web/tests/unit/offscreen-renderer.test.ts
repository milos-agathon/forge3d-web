import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Forge3DRuntimeCapabilities,
  SceneSnapshot,
} from "../../src-ts/index.js";
import { Forge3DOffscreenRenderer } from "../../src-ts/offscreen-renderer.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import { setSessionRuntimeFactoryForTests } from "../../src-ts/session.js";
import type { SessionRuntimeLike } from "../../src-ts/session.js";

const CAPABILITIES: Forge3DRuntimeCapabilities = {
  deviceState: "ready",
  maxTextureDimension2D: 4096,
  maxBufferSize: 1024 * 1024,
  surfaceFormat: "bgra8unorm",
};

class FakeRuntime implements SessionRuntimeLike {
  static instances: FakeRuntime[] = [];

  disposed = false;
  renderCalls = 0;
  scenes: SceneSnapshot[] = [];
  rgba = new Uint8Array(2 * 3 * 4).fill(7);
  screenshotBlob = new Blob([new Uint8Array([1, 2, 3])], {
    type: "image/png",
  });

  constructor() {
    FakeRuntime.instances.push(this);
  }

  getCapabilities(): Forge3DRuntimeCapabilities {
    return CAPABILITIES;
  }

  setScene(scene: SceneSnapshot): void {
    this.scenes.push(scene);
  }

  setDeviceLostHandler(): void {}

  render(): boolean {
    this.renderCalls += 1;
    return true;
  }

  screenshot(): Promise<Blob> {
    return Promise.resolve(this.screenshotBlob);
  }

  readRgba(): Promise<Uint8Array> {
    return Promise.resolve(this.rgba);
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

function installFactory(): void {
  setSessionRuntimeFactoryForTests(() =>
    Promise.resolve(new FakeRuntime()),
  );
}

afterEach(() => {
  setSessionRuntimeFactoryForTests(undefined);
  FakeRuntime.instances = [];
  vi.unstubAllGlobals();
});

describe("Forge3DOffscreenRenderer", () => {
  it("validates dimensions before touching platform APIs", async () => {
    installFactory();
    await expect(
      Forge3DOffscreenRenderer.create({ width: 0, height: 4 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      Forge3DOffscreenRenderer.create({ width: 4, height: 1.5 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws UNSUPPORTED_FEATURE when no canvas surface exists", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);
    await expect(
      Forge3DOffscreenRenderer.create({ width: 2, height: 2 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
  });

  it("falls back to an unattached hidden DOM canvas", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", undefined);
    const created: Array<Record<string, unknown>> = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          style: { display: "" },
        };
        created.push(canvas);
        return canvas;
      },
    });
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 5,
      height: 7,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      width: 5,
      height: 7,
      style: { display: "none" },
    });
    renderer.dispose();
  });

  it("captures every output kind through the session", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 2,
      height: 3,
    });
    const runtime = FakeRuntime.instances[0]!;

    const scene = Forge3DScene.create();
    scene.addGroundPlane({
      name: "ground",
      size: [2, 2],
      color: [1, 1, 1, 1],
    });
    renderer.setScene(scene);
    expect(runtime.scenes).toHaveLength(1);
    expect(renderer.render()).toBe(true);

    const blob = await renderer.capture("blob");
    expect(blob).toMatchObject({ kind: "blob" });
    expect((blob as { value: Blob }).value).toBe(runtime.screenshotBlob);

    const rgba = await renderer.capture("rgba8");
    expect(rgba).toMatchObject({ kind: "rgba8", width: 2, height: 3 });
    expect((rgba as { value: Uint8Array }).value.byteLength).toBe(24);

    const stream = (await renderer.capture("stream")) as {
      value: ReadableStream<Uint8Array>;
    };
    const reader = stream.value.getReader();
    const collected: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      collected.push(...value);
    }
    expect(collected).toEqual([1, 2, 3]);
    renderer.dispose();
  });

  it("rejects rgba8 readback with a mismatched byte count", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 2,
      height: 3,
    });
    FakeRuntime.instances[0]!.rgba = new Uint8Array(8);
    await expect(renderer.capture("rgba8")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    renderer.dispose();
  });

  it("captures image bitmaps when the platform supports it", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const bitmap = { fake: "bitmap" };
    vi.stubGlobal(
      "createImageBitmap",
      async (blob: Blob) => {
        expect(await blob.text()).toBe("\x01\x02\x03");
        return bitmap;
      },
    );
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 1,
      height: 1,
    });
    const output = await renderer.capture("image-bitmap");
    expect(output).toEqual({ kind: "image-bitmap", value: bitmap });
    renderer.dispose();
  });

  it("maps missing createImageBitmap to UNSUPPORTED_FEATURE", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("createImageBitmap", undefined);
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 1,
      height: 1,
    });
    await expect(renderer.capture("image-bitmap")).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
    renderer.dispose();
  });

  it("writes PNG bytes through a browser byte sink", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 1,
      height: 1,
    });
    const result = await renderer.write({ kind: "blob" });
    expect(result.bytesWritten).toBe(3);
    expect(new Uint8Array(await result.blob!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    renderer.dispose();
  });

  it("disposes the session exactly once", async () => {
    installFactory();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const renderer = await Forge3DOffscreenRenderer.create({
      width: 1,
      height: 1,
    });
    const runtime = FakeRuntime.instances[0]!;
    renderer.dispose();
    renderer.dispose();
    expect(renderer.disposed).toBe(true);
    expect(runtime.disposed).toBe(true);
    expect(() => renderer.render()).toThrowError(
      expect.objectContaining({ code: "RUNTIME_DISPOSED" }) as never,
    );
    await expect(renderer.capture("blob")).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
});
