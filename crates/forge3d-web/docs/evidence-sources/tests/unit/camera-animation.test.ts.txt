import { describe, expect, it } from "vitest";

import {
  CameraAnimation,
  CameraKeyframe,
  cameraStateEye,
  cameraStateToInput,
  cubicHermite,
  RenderConfig,
  RenderProgress,
} from "../../src-ts/camera-animation.js";
import type { CameraKeyframeInput, CameraState } from "../../src-ts/index.js";
import { expectClose, nativeFixture } from "./w05-fixture.js";

function expectState(actual: CameraState | undefined, expected: CameraState | null, context: string): void {
  if (expected === null) {
    expect(actual, context).toBeUndefined();
    return;
  }
  expect(actual, context).toBeDefined();
  expectClose(actual!.phiDeg, expected.phiDeg, `${context}.phi`);
  expectClose(actual!.thetaDeg, expected.thetaDeg, `${context}.theta`);
  expectClose(actual!.radius, expected.radius, `${context}.radius`);
  expectClose(actual!.fovDeg, expected.fovDeg, `${context}.fov`);
  if (expected.target === null) {
    expect(actual!.target, `${context}.target`).toBeNull();
  } else {
    for (let axis = 0; axis < 3; axis += 1) {
      expectClose(actual!.target![axis]!, expected.target[axis]!, `${context}.target[${axis}]`);
    }
  }
}

function build(keyframes: CameraKeyframeInput[]): CameraAnimation {
  const animation = new CameraAnimation();
  for (const keyframe of keyframes) {
    animation.addKeyframe(keyframe);
  }
  return animation;
}

describe("C03 CameraAnimation matches the native oracle", () => {
  it("reproduces sorted keyframes, durations, frame counts and samples", () => {
    for (const scenario of nativeFixture.animation) {
      const animation = build(scenario.input);
      const keyframes = animation.getKeyframes().map((keyframe) => keyframe.toJSON());
      expect(keyframes.length, scenario.name).toBe(scenario.keyframes.length);
      keyframes.forEach((keyframe, index) => {
        const expected = scenario.keyframes[index];
        expectClose(keyframe.time, expected.time, `${scenario.name}[${index}].time`);
        expectClose(keyframe.phiDeg, expected.phiDeg, `${scenario.name}[${index}].phi`);
        expect(keyframe.target === null).toBe(expected.target === null);
      });
      expectClose(animation.duration, scenario.duration, `${scenario.name}.duration`);
      for (const [fps, count] of Object.entries(scenario.frameCounts)) {
        expect(animation.getFrameCount(Number(fps)), `${scenario.name}@${fps}`).toBe(count);
      }
      for (const sample of scenario.samples) {
        expectState(animation.evaluate(sample.time), sample.state, `${scenario.name}@${sample.time}`);
      }
    }
  });

  it("reproduces the f32 keyframe store and Catmull-Rom basis exactly", () => {
    // Angles are stored and interpolated in f32 by both the 1f4084a baseline
    // and the native oracle, so they match bit-for-bit; the 1.34 oracle keeps
    // radius/target in f64 (inside the 1e-5 tolerance checked above).
    const scenario = nativeFixture.animation.find((item: { name: string }) => item.name === "three-keyframes");
    const animation = build(scenario.input);
    for (const sample of scenario.samples) {
      const state = animation.evaluate(sample.time)!;
      expect(state.phiDeg).toBe(sample.state.phiDeg);
      expect(state.thetaDeg).toBe(sample.state.thetaDeg);
    }
    expect(new CameraKeyframe({ time: 0.1, phiDeg: 0, thetaDeg: 0, radius: 1, fovDeg: 45 }).time).toBe(Math.fround(0.1));
    expect(cubicHermite(0, 1, 2, 3, 0)).toBe(1);
    expect(cubicHermite(0, 1, 2, 3, 1)).toBe(2);
  });
});

describe("C03 CameraAnimation editing (ported test_animation_mvp)", () => {
  it("starts empty and tracks duration and keyframe count", () => {
    const animation = new CameraAnimation();
    expect(animation.keyframeCount).toBe(0);
    expect(animation.duration).toBe(0);
    expect(animation.evaluate(0)).toBeUndefined();
    animation.addKeyframe({ time: 2, phiDeg: 45, thetaDeg: 30, radius: 1000, fovDeg: 60 });
    expect(animation.keyframeCount).toBe(1);
    expect(animation.duration).toBe(2);
  });

  it("sorts keyframes and returns an editable snapshot", () => {
    const animation = build([
      { time: 5, phiDeg: 180, thetaDeg: 30, radius: 3000, fovDeg: 60 },
      { time: 0, phiDeg: 0, thetaDeg: 45, radius: 5000, fovDeg: 60 },
      { time: 2.5, phiDeg: 90, thetaDeg: 35, radius: 4000, fovDeg: 60, target: [10, 20, 30] },
    ]);
    expect(animation.getKeyframes().map((keyframe) => keyframe.time)).toEqual([0, 2.5, 5]);
    const snapshot = animation.getKeyframes();
    snapshot.pop();
    expect(animation.keyframeCount).toBe(3);
    expect(animation.getKeyframes()[1]!.target).toEqual([10, 20, 30]);
    expect(Object.isFrozen(animation.getKeyframes()[1])).toBe(true);
  });

  it("replaces and clears keyframes, accepting CameraKeyframe instances", () => {
    const animation = build([{ time: 5, phiDeg: 180, thetaDeg: 35, radius: 3000, fovDeg: 60 }]);
    animation.replaceKeyframes([
      new CameraKeyframe({ time: 2, phiDeg: 90, thetaDeg: 40, radius: 2000, fovDeg: 55 }),
      { time: 0, phiDeg: 0, thetaDeg: 45, radius: 2500, fovDeg: 55, target: [1, 2, 3] },
    ]);
    expect(animation.getKeyframes().map((keyframe) => keyframe.time)).toEqual([0, 2]);
    expect(animation.getKeyframes()[0]!.target).toEqual([1, 2, 3]);
    animation.clearKeyframes();
    expect(animation.keyframeCount).toBe(0);
    expect(animation.duration).toBe(0);
  });

  it("evaluates keyframe times exactly, clamps outside the range and stays monotonic", () => {
    const animation = build([
      { time: 1, phiDeg: 0, thetaDeg: 45, radius: 1000, fovDeg: 60 },
      { time: 2, phiDeg: 90, thetaDeg: 45, radius: 1000, fovDeg: 60 },
    ]);
    expect(animation.evaluate(1)!.phiDeg).toBe(0);
    expect(animation.evaluate(2)!.phiDeg).toBe(90);
    expect(animation.evaluate(0)!.phiDeg).toBe(0);
    expect(animation.evaluate(10)!.phiDeg).toBe(90);
    let previous = -1;
    for (const t of [1, 1.25, 1.5, 1.75, 2]) {
      const phi = animation.evaluate(t)!.phiDeg;
      expect(phi).toBeGreaterThan(previous);
      previous = phi;
    }
    expect(Math.abs(animation.evaluate(1.5)!.phiDeg - 45)).toBeLessThan(5);
  });

  it("interpolates targets and counts inclusive frames", () => {
    const animation = build([
      { time: 0, phiDeg: 0, thetaDeg: 45, radius: 1000, fovDeg: 60, target: [0, 10, 0] },
      { time: 1, phiDeg: 90, thetaDeg: 45, radius: 1000, fovDeg: 60, target: [10, 20, 10] },
    ]);
    const target = animation.evaluate(0.5)!.target!;
    expect(Math.abs(target[0] - 5)).toBeLessThan(5);
    expect(Math.abs(target[1] - 15)).toBeLessThan(5);
    expect(animation.getFrameCount(30)).toBe(31);
    expect(animation.getFrameCount(60)).toBe(61);
    expect(animation.frameTimes(4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(animation.sample(2).map((sample) => sample.frame)).toEqual([0, 1, 2]);
    expect(String(animation)).toBe("CameraAnimation(keyframes=2, duration=1.00s)");
    expect(String(animation.getKeyframes()[0])).toContain("phi=0.00");
  });

  it("is deterministic and handles many keyframes", () => {
    const create = () =>
      build([
        { time: 0, phiDeg: 0, thetaDeg: 45, radius: 5000, fovDeg: 60 },
        { time: 2.5, phiDeg: 90, thetaDeg: 30, radius: 3000, fovDeg: 60 },
        { time: 5, phiDeg: 180, thetaDeg: 45, radius: 5000, fovDeg: 60 },
      ]);
    const first = create();
    const second = create();
    for (const t of [0, 1, 2.5, 3.5, 5]) {
      expect(first.evaluate(t)).toEqual(second.evaluate(t));
    }
    const many = build(
      Array.from({ length: 10 }, (_, index) => ({
        time: index,
        phiDeg: index * 36,
        thetaDeg: 45,
        radius: 1000,
        fovDeg: 60,
      })),
    );
    expect(many.duration).toBe(9);
    const phi = many.evaluate(4.5)!.phiDeg;
    expect(phi).toBeGreaterThan(140);
    expect(phi).toBeLessThan(185);
  });

  it("rejects non-finite keyframes and invalid inputs", () => {
    const animation = new CameraAnimation();
    expect(() => animation.addKeyframe({ time: Number.NaN, phiDeg: 0, thetaDeg: 0, radius: 1, fovDeg: 45 })).toThrow(/time/);
    expect(() =>
      animation.addKeyframe({ time: 0, phiDeg: 0, thetaDeg: 0, radius: 1, fovDeg: 45, target: [0, Infinity, 0] }),
    ).toThrow(/target/);
    expect(() => animation.getFrameCount(-1)).toThrow(/fps/);
    expect(() => animation.evaluate(Number.NaN)).toThrow(/time/);
  });

  it("round-trips through versioned JSON", () => {
    const animation = build([
      { time: 0, phiDeg: 10, thetaDeg: 45, radius: 12, fovDeg: 50, target: [1, 2, 3] },
      { time: 1.5, phiDeg: 80, thetaDeg: 35, radius: 9, fovDeg: 45, target: null },
    ]);
    const json = JSON.parse(JSON.stringify(animation));
    expect(json.kind).toBe("forge3d.camera-animation");
    const restored = CameraAnimation.fromJSON(json);
    for (const t of [0, 0.4, 1.2, 1.5]) {
      expect(restored.evaluate(t)).toEqual(animation.evaluate(t));
    }
    expect(() => CameraAnimation.fromJSON({ ...json, version: 2 })).toThrow(/version/);
  });

  it("converts states to renderer cameras with the rig eye convention", () => {
    const state: CameraState = { phiDeg: 0, thetaDeg: 90, radius: 10, fovDeg: 40, target: [1, 2, 3] };
    const eye = cameraStateEye(state);
    expectClose(eye[0], 11, "eye x");
    expectClose(eye[1], 2, "eye y");
    expectClose(eye[2], 3, "eye z");
    const camera = cameraStateToInput(state, { near: 0.5, far: 50 });
    expect(camera).toMatchObject({ target: [1, 2, 3], fovYDegrees: 40, near: 0.5, far: 50 });
    const untargeted = { ...state, target: null };
    expect(() => cameraStateEye(untargeted)).toThrow(/fallbackTarget/);
    expect(cameraStateToInput(untargeted, { fallbackTarget: [0, 0, 0] }).target).toEqual([0, 0, 0]);
    const animation = build([{ time: 0, phiDeg: 30, thetaDeg: 60, radius: 5, fovDeg: 50, target: [0, 0, 0] }]);
    expect(animation.cameraAt(0, { projection: "orthographic", orthographicHeight: 4 })).toMatchObject({
      projection: "orthographic",
      orthographicHeight: 4,
    });
    expect(new CameraAnimation().cameraAt(0)).toBeUndefined();
  });
});

describe("C03 RenderConfig and RenderProgress", () => {
  it("uses native defaults and frame naming", () => {
    const config = new RenderConfig();
    expect(config).toMatchObject({ fps: 30, width: 1920, height: 1080, filenamePrefix: "frame", frameDigits: 4 });
    expect(config.frameFileName(0)).toBe("frame_0000.png");
    expect(config.frameFileName(42)).toBe("frame_0042.png");
    expect(config.frameFileName(9999)).toBe("frame_9999.png");
    const custom = new RenderConfig({ outputDir: "renders/flyover/", fps: 60, width: 3840, height: 2160 });
    expect(custom.framePath(7)).toBe("renders/flyover/frame_0007.png");
    expect(() => new RenderConfig({ fps: 0 })).toThrow(/fps/);
    expect(() => new RenderConfig({ filenamePrefix: "a/b" })).toThrow(/separators/);
    expect(() => config.frameFileName(-1)).toThrow(/frame/);
  });

  it("creates nested output directories under a directory handle", async () => {
    const created: string[] = [];
    const handle = (path: string): FileSystemDirectoryHandle =>
      ({
        getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
          expect(options?.create).toBe(true);
          const next = path === "" ? name : `${path}/${name}`;
          created.push(next);
          return handle(next);
        },
      }) as unknown as FileSystemDirectoryHandle;
    await new RenderConfig({ outputDir: "nested/output" }).ensureOutputDir(handle(""));
    expect(created).toEqual(["nested", "nested/output"]);
    await expect(new RenderConfig({ outputDir: "../escape" }).ensureOutputDir(handle(""))).rejects.toThrow(/escape/);
    await expect(new RenderConfig().ensureOutputDir({} as FileSystemDirectoryHandle)).rejects.toThrow(/FileSystemDirectoryHandle/);
  });

  it("reports progress fractions", () => {
    expect(new RenderProgress(50, 100, 1.67, "frame_0050.png").percent).toBeCloseTo(0.5, 6);
    expect(new RenderProgress(0, 0, 0, "frame_0000.png").percent).toBe(0);
    expect(String(new RenderProgress(1, 4, 0, "x"))).toBe("RenderProgress(1/4, 25.0%)");
  });
});
