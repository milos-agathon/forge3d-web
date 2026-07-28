import { describe, expect, it } from "vitest";

import {
  ResizeController,
  computeBackingSize,
  type ResizeObserverLike,
} from "../../src-ts/resize-controller.js";
import { OwnedDomResources } from "../../src-ts/viewer-controls.js";

describe("computeBackingSize", () => {
  it("handles fractional CSS sizes and DPR", () => {
    expect(
      computeBackingSize({
        cssWidth: 320.5,
        cssHeight: 180.25,
        devicePixelRatio: 1.5,
        maxDevicePixelRatio: 2,
        maxCanvasPixels: 8_294_400,
        maxTextureDimension2D: 8_192,
      }),
    ).toMatchObject({
      width: 480,
      height: 270,
    });
  });

  it("preserves aspect while respecting pixel and texture ceilings", () => {
    const size = computeBackingSize({
      cssWidth: 1_000,
      cssHeight: 500,
      devicePixelRatio: 3,
      maxDevicePixelRatio: 3,
      maxCanvasPixels: 1_000_000,
      maxTextureDimension2D: 1_200,
    });
    expect(size).not.toBeNull();
    expect(size!.width).toBeLessThanOrEqual(1_200);
    expect(size!.height).toBeLessThanOrEqual(1_200);
    expect(size!.width * size!.height).toBeLessThanOrEqual(1_000_000);
    expect(size!.width / size!.height).toBeCloseTo(2, 2);
  });

  it("uses device-pixel content-box measurements when supplied", () => {
    const size = computeBackingSize({
      cssWidth: 100,
      cssHeight: 50,
      devicePixelRatio: 2,
      devicePixelWidth: 150,
      devicePixelHeight: 75,
      maxDevicePixelRatio: 2,
      maxCanvasPixels: 1_000_000,
      maxTextureDimension2D: 4_096,
    });
    expect(size).toMatchObject({ width: 150, height: 75 });
  });

  it("suspends zero-sized content", () => {
    expect(
      computeBackingSize({
        cssWidth: 0,
        cssHeight: 10,
        devicePixelRatio: 2,
        maxDevicePixelRatio: 2,
        maxCanvasPixels: 100,
        maxTextureDimension2D: 100,
      }),
    ).toBeNull();
  });
});

describe("ResizeController", () => {
  it("owns its observer, re-reads DPR, deduplicates commits, and cleans up", () => {
    const canvas = new FakeCanvas();
    const resources = new OwnedDomResources();
    const windowTarget = new EventTarget();
    const observerHarness = new FakeResizeObserverHarness();
    const commits: Array<{ width: number; height: number; devicePixelRatio: number }> = [];
    const suspensionChanges: boolean[] = [];
    let dpr = 1;
    const controller = new ResizeController({
      canvas: canvas as unknown as HTMLCanvasElement,
      onResize: (size) => commits.push(size),
      onSuspendedChange: (suspended) => suspensionChanges.push(suspended),
      maxDevicePixelRatio: 2,
      maxCanvasPixels: 1_000_000,
      maxTextureDimension2D: 4_096,
      getDevicePixelRatio: () => dpr,
      observerFactory: observerHarness.factory,
      windowTarget,
      resources,
    });

    expect(resources.activeObservers).toBe(1);
    expect(commits.at(-1)).toEqual({ width: 100, height: 50, devicePixelRatio: 1 });
    dpr = 2;
    windowTarget.dispatchEvent(new Event("resize"));
    expect(commits.at(-1)).toEqual({ width: 200, height: 100, devicePixelRatio: 1 });
    windowTarget.dispatchEvent(new Event("resize"));
    expect(commits).toHaveLength(2);

    observerHarness.deliver(canvas, 0, 0);
    expect(controller.suspended).toBe(true);
    expect(suspensionChanges.at(-1)).toBe(true);
    canvas.widthCss = 50;
    canvas.heightCss = 100;
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(controller.suspended).toBe(false);
    expect(commits.at(-1)).toEqual({ width: 100, height: 200, devicePixelRatio: 1 });

    controller.dispose();
    expect(resources.activeObservers).toBe(0);
    expect(resources.ownedListeners).toBe(0);
    expect(observerHarness.disconnected).toBe(true);
  });
});

class FakeCanvas extends EventTarget {
  widthCss = 100;
  heightCss = 50;

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: this.widthCss,
      height: this.heightCss,
      top: 0,
      right: this.widthCss,
      bottom: this.heightCss,
      left: 0,
      toJSON: () => ({}),
    };
  }
}

class FakeResizeObserverHarness {
  callback: ResizeObserverCallback | undefined;
  disconnected = false;

  readonly factory = (callback: ResizeObserverCallback): ResizeObserverLike => {
    this.callback = callback;
    return {
      observe: () => {},
      disconnect: () => {
        this.disconnected = true;
      },
    };
  };

  deliver(target: EventTarget, width: number, height: number): void {
    const entry = {
      target,
      contentRect: { width, height },
      contentBoxSize: [{ inlineSize: width, blockSize: height }],
      devicePixelContentBoxSize: [],
      borderBoxSize: [],
    } as unknown as ResizeObserverEntry;
    this.callback?.([entry], {} as ResizeObserver);
  }
}
