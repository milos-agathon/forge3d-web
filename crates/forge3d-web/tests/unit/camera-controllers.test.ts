import { describe, expect, it } from "vitest";

import {
  CameraController,
  cameraDirection,
  DEFAULT_CAMERA_KEY_BINDINGS,
  FlyController,
  flyInputAxes,
  replayCameraInput,
  resolveCameraKeyBindings,
  yawPitchFromDirection,
} from "../../src-ts/camera-controllers.js";
import type { CameraInput, CameraInputEvent, Vec3 } from "../../src-ts/index.js";
import { OrbitController } from "../../src-ts/orbit-controller.js";
import { RenderScheduler } from "../../src-ts/render-scheduler.js";
import { OwnedDomResources, ViewerControls } from "../../src-ts/viewer-controls.js";

function close(actual: readonly number[], expected: readonly number[], tolerance = 1e-9): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index]!), `component ${index}: ${value} vs ${expected[index]}`).toBeLessThan(tolerance);
  });
}

function viewDirection(camera: CameraInput): Vec3 {
  const d: Vec3 = [
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ];
  const length = Math.hypot(...d);
  return [d[0] / length, d[1] / length, d[2] / length];
}

describe("C02 FlyController (native FPS camera)", () => {
  it("moves along the native forward/right/up axes at moveSpeed units per second", () => {
    const fly = new FlyController({ position: [0, 5, 10], yawDegrees: 180, pitchDegrees: 0, fovYDegrees: 50, near: 0.1, far: 100 });
    close(fly.forward, [0, 0, -1]);
    close(fly.right, [1, 0, 0]);
    expect(fly.update(0.5, { forward: true })).toBe(true);
    close(fly.getView().position, [0, 5, 7.5]);
    fly.update(0.5, { right: true, up: true, boost: true });
    close(fly.getView().position, [5, 10, 7.5]);
    expect(fly.update(1, { forward: true, backward: true })).toBe(false);
    expect(fly.update(0, { forward: true })).toBe(false);
    // Native move_forward follows the full pitched view direction.
    fly.lookBy(0, 30);
    const before = fly.getView().position;
    fly.moveBy(2, 0, 0);
    const after = fly.getView().position;
    close([after[1] - before[1]], [2 * Math.sin(Math.PI / 6)], 1e-12);
  });

  it("clamps pitch to the native 0.01 rad margin and wraps yaw", () => {
    const fly = new FlyController();
    fly.lookBy(190, 500);
    const view = fly.getView();
    expect(view.yawDegrees).toBeCloseTo(-170, 10);
    expect(view.pitchDegrees).toBeCloseTo(90 - 0.01 * (180 / Math.PI), 10);
    fly.zoomBy(1000);
    expect(fly.getView().fovYDegrees).toBe(179);
    expect(fly.reset()).toBe(true);
    expect(fly.getView()).toEqual(new FlyController().getView());
  });

  it("derives views from cameras and validates input", () => {
    const view = FlyController.viewFromCamera({
      position: [1, 2, 3],
      target: [1, 2, 13],
      up: [0, 1, 0],
      fovYDegrees: 40,
      near: 0.5,
      far: 500,
    });
    expect(view.yawDegrees).toBeCloseTo(0, 12);
    expect(view.pitchDegrees).toBeCloseTo(0, 12);
    close(new FlyController(view).getCamera().target, [1, 2, 4]);
    expect(() => new FlyController({ ...view, near: 0 })).toThrow(/near/);
    expect(() => new FlyController(view, { moveSpeed: -1 })).toThrow(/moveSpeed/);
    expect(() => new FlyController(view, { maxPitchDegrees: 95 })).toThrow(/pitch/);
    expect(() => new FlyController(view).update(-1, {})).toThrow(/deltaSeconds/);
  });

  it("resolves held-key axes with boost", () => {
    expect(flyInputAxes({ forward: true, left: true, down: true })).toEqual([1, -1, -1]);
    expect(flyInputAxes({ forward: true, boost: true }, 3)).toEqual([3, 0, 0]);
    close(cameraDirection(90, 0), [1, 0, 0], 1e-12);
    const [yaw, pitch] = yawPitchFromDirection(cameraDirection(-35, 20));
    expect(yaw).toBeCloseTo(-35, 10);
    expect(pitch).toBeCloseTo(20, 10);
    expect(() => yawPitchFromDirection([0, 0, 0])).toThrow(/nonzero/);
  });
});

describe("C02 CameraController mode switching", () => {
  it("keeps eye and view direction continuous across orbit/fly switches", () => {
    const controller = new CameraController({
      orbit: { target: [1, 2, 3], distance: 10, yawDegrees: 40, pitchDegrees: 25, fovYDegrees: 50, near: 0.1, far: 200 },
    });
    const orbitCamera = controller.getCamera();
    expect(controller.setMode("fly")).toBe(true);
    expect(controller.mode).toBe("fly");
    const flyCamera = controller.getCamera();
    close(flyCamera.position, orbitCamera.position, 1e-9);
    close(viewDirection(flyCamera), viewDirection(orbitCamera), 1e-9);
    expect(flyCamera.fovYDegrees).toBe(50);
    controller.apply({ type: "move", forward: 2, right: 1, up: 0.5 });
    const moved = controller.getCamera();
    expect(controller.toggleMode()).toBe("orbit");
    const back = controller.getCamera();
    close(back.position, moved.position, 1e-9);
    close(viewDirection(back), viewDirection(moved), 1e-9);
    expect(controller.orbit.getView().distance).toBe(10);
    expect(controller.setMode("orbit")).toBe(false);
  });

  it("routes events to the active controller only (native routing)", () => {
    const controller = new CameraController();
    expect(controller.apply({ type: "look", deltaYawDegrees: 5, deltaPitchDegrees: 0 })).toBe(false);
    expect(controller.apply({ type: "tick", deltaSeconds: 1 })).toBe(false);
    expect(controller.apply({ type: "orbit", deltaYawDegrees: 5, deltaPitchDegrees: 1 })).toBe(true);
    controller.setMode("fly");
    expect(controller.apply({ type: "zoom", delta: 100 })).toBe(false);
    expect(controller.apply({ type: "pan", deltaX: 5, deltaY: 5, viewportHeight: 100 })).toBe(false);
    expect(controller.apply({ type: "look", deltaYawDegrees: 5, deltaPitchDegrees: 0 })).toBe(true);
  });

  it("drives fly movement from key bindings and ticks", () => {
    const controller = new CameraController({ mode: "fly", fly: { position: [0, 0, 0], yawDegrees: 0, pitchDegrees: 0, fovYDegrees: 45, near: 0.1, far: 100 } });
    expect(controller.moving).toBe(false);
    controller.apply({ type: "key", code: "KeyW", pressed: true });
    controller.apply({ type: "key", code: "ShiftLeft", pressed: true });
    expect(controller.moving).toBe(true);
    expect(controller.flyInput).toMatchObject({ forward: true, boost: true });
    controller.apply({ type: "tick", deltaSeconds: 0.1 });
    close(controller.fly.getView().position, [0, 0, 1]);
    controller.apply({ type: "key", code: "KeyW", pressed: false });
    expect(controller.moving).toBe(false);
    controller.apply({ type: "key", code: "KeyE", pressed: true });
    controller.apply({ type: "releaseKeys" });
    expect(controller.moving).toBe(false);
    expect(controller.apply({ type: "key", code: "KeyV", pressed: true })).toBe(true);
    expect(controller.mode).toBe("orbit");
    // Held toggle keys do not re-toggle until released.
    expect(controller.apply({ type: "key", code: "KeyV", pressed: true })).toBe(false);
    controller.apply({ type: "key", code: "KeyV", pressed: false });
    controller.apply({ type: "key", code: "KeyV", pressed: true });
    expect(controller.mode).toBe("fly");
  });

  it("supports custom bindings and rejects conflicts", () => {
    const controller = new CameraController({ mode: "fly", bindings: { forward: ["KeyI"], toggleMode: ["Tab"] } });
    expect(controller.bindings.forward).toEqual(["KeyI"]);
    expect(controller.bindings.backward).toEqual(DEFAULT_CAMERA_KEY_BINDINGS.backward);
    controller.apply({ type: "key", code: "KeyW", pressed: true });
    expect(controller.moving).toBe(false);
    controller.apply({ type: "key", code: "Tab", pressed: true });
    expect(controller.mode).toBe("orbit");
    expect(() => resolveCameraKeyBindings({ forward: ["KeyS"] })).toThrow(/bound to both/);
    expect(() => resolveCameraKeyBindings({ jump: ["Space"] } as never)).toThrow(/unknown/);
    expect(() => resolveCameraKeyBindings({ up: [""] })).toThrow(/KeyboardEvent.code/);
  });

  it("sets both controllers from a look-at camera and restores state", () => {
    const controller = new CameraController();
    const camera: CameraInput = { position: [4, 3, 8], target: [1, 0.5, -2], up: [0, 1, 0], fovYDegrees: 35, near: 0.2, far: 300 };
    controller.setCamera(camera);
    close(controller.getCamera().position, camera.position, 1e-9);
    close(viewDirection(controller.getCamera()), viewDirection(camera), 1e-9);
    controller.setMode("fly");
    close(controller.getCamera().position, camera.position, 1e-9);
    const state = controller.getState();
    const other = new CameraController();
    expect(other.setState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(other.getCamera()).toEqual(controller.getCamera());
    expect(() => other.setState({ ...state, mode: "walk" as "fly" })).toThrow(/mode/);
    expect(controller.resetAll()).toBe(true);
    expect(controller.mode).toBe("orbit");
  });

  it("replays recorded input deterministically (bit-identical cameras)", () => {
    const options = { orbit: { target: [0, 0, 0] as Vec3, distance: 6, yawDegrees: 10, pitchDegrees: 20, fovYDegrees: 46, near: 0.01, far: 100 } };
    const live = new CameraController(options);
    live.startRecording();
    const script: CameraInputEvent[] = [
      { type: "orbit", deltaYawDegrees: 12.5, deltaPitchDegrees: -3.25 },
      { type: "pan", deltaX: 14, deltaY: -9, viewportHeight: 480 },
      { type: "zoom", delta: -240 },
      { type: "key", code: "KeyV", pressed: true },
      { type: "key", code: "KeyV", pressed: false },
      { type: "key", code: "KeyW", pressed: true },
      { type: "tick", deltaSeconds: 0.016 },
      { type: "tick", deltaSeconds: 0.017 },
      { type: "look", deltaYawDegrees: -4, deltaPitchDegrees: 2 },
      { type: "key", code: "KeyD", pressed: true },
      { type: "tick", deltaSeconds: 0.033 },
      { type: "key", code: "KeyW", pressed: false },
      { type: "key", code: "KeyD", pressed: false },
      { type: "mode", mode: "orbit" },
      { type: "reset" },
      { type: "orbit", deltaYawDegrees: 1, deltaPitchDegrees: 1 },
    ];
    for (const event of script) {
      live.apply(event);
    }
    const recorded = live.stopRecording();
    expect(recorded).toEqual(script);
    expect(live.recording).toBe(false);
    const replayed = replayCameraInput(options, JSON.parse(JSON.stringify(recorded)));
    expect(replayed).toEqual(live.getCamera());
    expect(() => live.apply({ type: "warp" } as never)).toThrow(/unknown/);
    expect(() => live.apply({ type: "tick", deltaSeconds: Number.NaN })).toThrow(/deltaSeconds/);
  });

  it("wraps an existing OrbitController", () => {
    const orbit = new OrbitController();
    const controller = new CameraController({}, orbit);
    controller.apply({ type: "orbit", deltaYawDegrees: 30, deltaPitchDegrees: 0 });
    expect(orbit.getView().yawDegrees).toBe(30);
  });
});

describe("C02 ViewerControls fly mode", () => {
  it("toggles modes, looks with the pointer and moves on animation frames", () => {
    const canvas = new FakeCanvas();
    const resources = new OwnedDomResources();
    const controller = new CameraController({
      orbit: { target: [0, 0, 0], distance: 5, yawDegrees: 0, pitchDegrees: 20, fovYDegrees: 46, near: 0.01, far: 100 },
    });
    let invalidations = 0;
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      controller,
      {},
      () => {
        invalidations += 1;
      },
      resources,
    );
    expect(controls.cameraController).toBe(controller);
    controller.startRecording();

    canvas.dispatchEvent(keyEvent("keydown", "KeyV"));
    canvas.dispatchEvent(keyEvent("keyup", "KeyV"));
    expect(controller.mode).toBe("fly");
    expect(invalidations).toBe(1);

    const yaw = controller.fly.getView().yawDegrees;
    canvas.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10));
    canvas.dispatchEvent(pointerEvent("pointermove", 1, 30, 10));
    canvas.dispatchEvent(pointerEvent("pointerup", 1, 30, 10, 0));
    expect(controller.fly.getView().yawDegrees).toBeCloseTo(yaw - 20 * 0.25, 10);

    const start = controller.fly.getView().position;
    const down = keyEvent("keydown", "KeyW");
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(controller.moving).toBe(true);
    expect(controls.onAnimationFrame(1000)).toBe(true);
    close(controller.fly.getView().position, start);
    expect(controls.onAnimationFrame(1050)).toBe(true);
    const moved = controller.fly.getView().position;
    const forward = controller.fly.forward;
    close(moved, start.map((value, axis) => value + forward[axis]! * 5 * 0.05), 1e-9);
    // Long stalls are capped to 0.1 s of movement.
    controls.onAnimationFrame(6050);
    const capped = controller.fly.getView().position;
    close(capped, moved.map((value, axis) => value + forward[axis]! * 5 * 0.1), 1e-9);
    canvas.dispatchEvent(keyEvent("keyup", "KeyW"));
    expect(controls.onAnimationFrame(6100)).toBe(false);

    canvas.dispatchEvent(keyEvent("keydown", "KeyS"));
    canvas.dispatchEvent(new Event("blur"));
    expect(controller.moving).toBe(false);

    const recorded = controller.stopRecording();
    const replay = new CameraController({
      orbit: { target: [0, 0, 0], distance: 5, yawDegrees: 0, pitchDegrees: 20, fovYDegrees: 46, near: 0.01, far: 100 },
    });
    replay.replay(recorded);
    expect(replay.getCamera()).toEqual(controller.getCamera());

    canvas.dispatchEvent(keyEvent("keydown", "KeyW"));
    controls.suspend();
    expect(controller.moving).toBe(false);
    controls.resume();
    controls.dispose();
    expect(resources.ownedListeners).toBe(0);
  });

  it("keeps orbit keyboard behaviour and ignores fly keys in orbit mode", () => {
    const canvas = new FakeCanvas();
    const orbit = new OrbitController();
    const controls = new ViewerControls(canvas as unknown as HTMLCanvasElement, orbit, {
      bindings: { toggleMode: ["KeyC"] },
      fly: { moveSpeed: 2 },
    });
    canvas.dispatchEvent(keyEvent("keydown", "ArrowLeft", "ArrowLeft"));
    expect(orbit.getView().yawDegrees).toBe(-2);
    canvas.dispatchEvent(keyEvent("keydown", "KeyW", "w"));
    expect(controls.cameraController.moving).toBe(false);
    canvas.dispatchEvent(keyEvent("keydown", "KeyC", "c"));
    expect(controls.cameraController.mode).toBe("fly");
    expect(controls.cameraController.fly.moveSpeed).toBe(2);
    // Orbit arrows are fly movement bindings in fly mode.
    const before = controls.cameraController.fly.getView().position;
    canvas.dispatchEvent(keyEvent("keydown", "ArrowUp", "ArrowUp"));
    controls.onAnimationFrame(0);
    controls.onAnimationFrame(100);
    expect(controls.cameraController.fly.getView().position).not.toEqual(before);
    expect(orbit.getView().yawDegrees).toBe(-2);
    controls.dispose();
  });

  it("keeps the scheduler animating while onFrame reports movement", () => {
    const frames: FrameRequestCallback[] = [];
    let remaining = 3;
    let submitted = 0;
    const scheduler = new RenderScheduler({
      submitFrame: () => {
        submitted += 1;
      },
      requestAnimationFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame: () => {},
      onFrame: () => {
        remaining -= 1;
        return remaining > 0;
      },
    });
    scheduler.requestRender();
    for (let index = 0; index < 10 && frames.length > 0; index += 1) {
      frames.shift()!(index * 16);
    }
    expect(submitted).toBe(3);
    expect(scheduler.ownedAnimationFrameCount).toBe(0);
    scheduler.dispose();
  });
});

class FakeCanvas extends EventTarget {
  readonly style = new FakeStyle();
  readonly captures = new Set<number>();
  readonly #attributes = new Map<string, string>();
  clientHeight = 400;

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  setPointerCapture(pointerId: number): void {
    this.captures.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captures.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captures.delete(pointerId);
  }

  focus(): void {}

  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, width: 800, height: 400, top: 0, right: 800, bottom: 400, left: 0, toJSON: () => ({}) };
  }
}

class FakeStyle {
  readonly #properties = new Map<string, { value: string; priority: string }>();

  get length(): number {
    return this.#properties.size;
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

function eventWith(type: string, properties: Record<string, unknown>): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number, buttons = 1): Event {
  return eventWith(type, { pointerId, pointerType: "mouse", button: 0, buttons, shiftKey: false, clientX, clientY });
}

function keyEvent(type: string, code: string, key = code): Event {
  return eventWith(type, { code, key, repeat: false, shiftKey: false });
}
