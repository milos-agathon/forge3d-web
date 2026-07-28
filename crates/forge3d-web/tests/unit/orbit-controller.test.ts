import { describe, expect, it } from "vitest";

import {
  OrbitController,
  defaultOrbitView,
} from "../../src-ts/orbit-controller.js";

describe("OrbitController", () => {
  it("derives a complete deterministic Y-up camera", () => {
    const controller = new OrbitController();
    const camera = controller.getCamera();

    expect(camera.target).toEqual([0, 0, 0]);
    expect(camera.up).toEqual([0, 1, 0]);
    expect(camera.position[0]).toBe(0);
    expect(camera.position[1]).toBeCloseTo(2.72 * Math.sin((24 * Math.PI) / 180));
    expect(camera.position[2]).toBeCloseTo(2.72 * Math.cos((24 * Math.PI) / 180));
    expect(camera.fovYDegrees).toBe(46);
  });

  it("orbits, clamps, zooms exponentially, resets, and round-trips state", () => {
    const controller = new OrbitController(defaultOrbitView(), {
      minDistance: 1,
      maxDistance: 10,
      minPitchDegrees: -30,
      maxPitchDegrees: 30,
    });

    controller.orbitBy(450, 500);
    expect(controller.getView()).toMatchObject({
      yawDegrees: 450,
      pitchDegrees: 30,
    });
    controller.zoomBy(-1_000_000);
    expect(controller.getView().distance).toBe(1);
    controller.zoomBy(1_000_000);
    expect(controller.getView().distance).toBeCloseTo(10);

    const view = controller.getView();
    view.target[0] = 99;
    expect(controller.getView().target[0]).toBe(0);
    expect(controller.setView({ ...view, fovYDegrees: 1_000 })).toBe(true);
    expect(controller.getView().fovYDegrees).toBe(179);
    expect(controller.reset()).toBe(true);
    expect(controller.getView()).toEqual(defaultOrbitView());
  });

  it("scales pan from CSS height and not device pixel ratio", () => {
    const first = new OrbitController();
    const second = new OrbitController();

    first.panBy(20.5, -11.25, 400);
    second.panBy(20.5, -11.25, 400);
    expect(first.getView()).toEqual(second.getView());

    const halfHeight = new OrbitController();
    halfHeight.panBy(20.5, -11.25, 200);
    expect(Math.abs(halfHeight.getView().target[0])).toBeCloseTo(
      Math.abs(first.getView().target[0]) * 2,
    );
  });

  it("rejects invalid state before it can reach a runtime", () => {
    const controller = new OrbitController();
    expect(() => controller.orbitBy(Number.NaN, 0)).toThrow(/finite/);
    expect(() => controller.zoomBy(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => controller.panBy(1, 1, 0)).toThrow(/greater than zero/);
    expect(() =>
      controller.setView({ ...defaultOrbitView(), near: 2, far: 1 }),
    ).toThrow(/far must be greater/);
  });

  it("repeats the same sequence bitwise-identically", () => {
    const run = (): string => {
      const controller = new OrbitController();
      for (let index = 0; index < 100; index += 1) {
        controller.orbitBy(index / 7, -index / 13);
        controller.panBy(index / 11, -index / 17, 777.5);
        controller.zoomBy((index % 9) - 4);
      }
      return JSON.stringify({
        view: controller.getView(),
        camera: controller.getCamera(),
      });
    };

    expect(run()).toBe(run());
  });

  it("keeps ten thousand randomized finite deltas valid", () => {
    const controller = new OrbitController();
    let state = 0x1234_5678;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };

    for (let index = 0; index < 10_000; index += 1) {
      controller.orbitBy((random() - 0.5) * 20, (random() - 0.5) * 20);
      controller.panBy((random() - 0.5) * 10, (random() - 0.5) * 10, 0.5 + random() * 2_000);
      controller.zoomBy((random() - 0.5) * 500);
      const view = controller.getView();
      const camera = controller.getCamera();
      expect(allFinite([...view.target, view.distance, view.near, view.far])).toBe(true);
      expect(allFinite([...camera.position, ...camera.target, ...camera.up])).toBe(true);
      expect(view.distance).toBeGreaterThan(0);
      expect(view.pitchDegrees).toBeGreaterThanOrEqual(-89);
      expect(view.pitchDegrees).toBeLessThanOrEqual(89);
      expect(view.fovYDegrees).toBeGreaterThanOrEqual(1);
      expect(view.fovYDegrees).toBeLessThanOrEqual(179);
      expect(view.far).toBeGreaterThan(view.near);
    }
  });
});

function allFinite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}
