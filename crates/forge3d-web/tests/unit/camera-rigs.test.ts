import { describe, expect, it } from "vitest";

import { CameraAnimation, CameraKeyframe, cameraStateEye } from "../../src-ts/camera-animation.js";
import {
  TERRAIN_CLEARANCE_TOLERANCE,
  TerrainClearance,
  TerrainOrbitRig,
  TerrainRailRig,
  TerrainRigSource,
  TerrainTargetFollowRig,
  terrainRigFromJSON,
  viewerOrbitRadius,
  type TerrainRig,
} from "../../src-ts/camera-rigs.js";
import { TerrainDataset } from "../../src-ts/terrain-dataset.js";
import {
  browserMessage,
  expectClose,
  heightmapFromRecipe,
  nativeFixture,
} from "./w05-fixture.js";

type Scenario = any;

function sourceFor(scenario: Scenario): TerrainRigSource {
  const { heights, width, height } = heightmapFromRecipe(scenario.source.heightmap);
  return new TerrainRigSource({
    heights,
    width,
    height,
    zScale: scenario.source.zScale,
    terrainWidth: scenario.source.terrainWidth,
  });
}

function rigFor(scenario: Scenario): TerrainRig {
  switch (scenario.kind) {
    case "orbit":
      return new TerrainOrbitRig(scenario.rig);
    case "rail":
      return new TerrainRailRig(scenario.rig);
    default:
      return new TerrainTargetFollowRig(scenario.rig);
  }
}

function flat(): TerrainRigSource {
  return new TerrainRigSource({ heights: new Float32Array(64 * 64), width: 64, height: 64, terrainWidth: 100 });
}

function assertClear(animation: CameraAnimation, source: TerrainRigSource, minimum: number, fps: number): void {
  const total = animation.getFrameCount(fps);
  for (let frame = 0; frame < total; frame += 1) {
    const state = animation.evaluate(frame / fps)!;
    expect(state.target).not.toBeNull();
    const eye = cameraStateEye(state);
    for (const value of [state.target![0], state.target![2], eye[0], eye[2]]) {
      expect(value).toBeGreaterThanOrEqual(-1e-4);
      expect(value).toBeLessThanOrEqual(source.terrainWidth + 1e-4);
    }
    const safe = source.heightAt(eye[0], eye[2]) + minimum;
    expect(eye[1] + TERRAIN_CLEARANCE_TOLERANCE).toBeGreaterThanOrEqual(safe);
  }
}

describe("C04 terrain rigs bake the native keyframes and paths", () => {
  for (const scenario of nativeFixture.rigs as Scenario[]) {
    it(`${scenario.name} matches native keyframes and samples within 1e-5`, () => {
      const animation = rigFor(scenario).bake(sourceFor(scenario), {
        samplesPerSecond: scenario.samplesPerSecond,
      });
      const keyframes = animation.getKeyframes();
      expect(keyframes.length).toBe(scenario.keyframes.length);
      keyframes.forEach((keyframe, index) => {
        const expected = scenario.keyframes[index];
        const context = `${scenario.name}[${index}]`;
        expectClose(keyframe.time, expected.time, `${context}.time`);
        expectClose(keyframe.phiDeg, expected.phiDeg, `${context}.phi`);
        expectClose(keyframe.thetaDeg, expected.thetaDeg, `${context}.theta`);
        expectClose(keyframe.radius, expected.radius, `${context}.radius`);
        expectClose(keyframe.fovDeg, expected.fovDeg, `${context}.fov`);
        for (let axis = 0; axis < 3; axis += 1) {
          expectClose(keyframe.target![axis]!, expected.target[axis], `${context}.target[${axis}]`);
        }
      });
      expect(animation.getFrameCount(scenario.fps)).toBe(scenario.frameCount);
      for (const sample of scenario.samples) {
        const state = animation.evaluate(sample.time)!;
        const context = `${scenario.name}@${sample.time}`;
        expectClose(state.phiDeg, sample.state.phiDeg, `${context}.phi`);
        expectClose(state.thetaDeg, sample.state.thetaDeg, `${context}.theta`);
        expectClose(state.radius, sample.state.radius, `${context}.radius`);
        expectClose(state.fovDeg, sample.state.fovDeg, `${context}.fov`);
        for (let axis = 0; axis < 3; axis += 1) {
          expectClose(state.target![axis]!, sample.state.target[axis], `${context}.target[${axis}]`);
        }
      }
    });

    it(`${scenario.name} is deterministic and never violates clearance`, () => {
      const source = sourceFor(scenario);
      const first = rigFor(scenario).bake(source, { samplesPerSecond: scenario.samplesPerSecond });
      const second = rigFor(scenario).bake(source, { samplesPerSecond: scenario.samplesPerSecond });
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      assertClear(first, source, scenario.rig.clearance?.minimumHeight ?? 0, scenario.fps);
    });
  }
});

describe("C04 ported test_camera_rigs behaviours", () => {
  it("orbit rig keeps its target and radius", () => {
    const animation = new TerrainOrbitRig({
      targetXZ: [50, 50],
      duration: 2,
      radius: 20,
      phiStartDeg: 0,
      phiEndDeg: 90,
      thetaStartDeg: 60,
      fovStartDeg: 50,
      clearance: { minimumHeight: 2 },
    }).bake(flat(), { samplesPerSecond: 10 });
    expect(animation.getFrameCount(10)).toBe(21);
    const midpoint = animation.evaluate(1)!;
    expect(midpoint.target).toEqual([50, 0, 50]);
    expect(Math.abs(midpoint.radius - 20)).toBeLessThanOrEqual(1);
  });

  it("rail rig moves at constant speed with look-ahead", () => {
    const animation = new TerrainRailRig({
      pathXZ: [[10, 10], [90, 10]],
      duration: 2,
      cameraHeightOffset: 15,
      lookAheadDistance: 10,
      fovDeg: 55,
    }).bake(flat(), { samplesPerSecond: 8 });
    expect(Math.abs(animation.evaluate(0.5)!.target![0] - 40)).toBeLessThanOrEqual(1);
    const one = animation.evaluate(1)!;
    expect(Math.abs(one.target![0] - 60)).toBeLessThanOrEqual(1);
    const eye = cameraStateEye(one);
    expect(Math.abs(eye[0] - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(eye[2] - 10)).toBeLessThanOrEqual(1);
  });

  it("follow rig stays behind the path tangent", () => {
    const animation = new TerrainTargetFollowRig({
      targetPathXZ: [[10, 30], [10, 90]],
      duration: 2,
      radius: 20,
      thetaDeg: 60,
      headingOffsetDeg: 180,
      fovDeg: 45,
      clearance: { minimumHeight: 2 },
    }).bake(flat(), { samplesPerSecond: 8 });
    const state = animation.evaluate(1)!;
    const eye = cameraStateEye(state);
    expect(eye[2]).toBeLessThan(state.target![2]);
    expect(eye[1]).toBeGreaterThan(state.target![1]);
  });

  it("clearance lifts the eye and recomputes orbit parameters", () => {
    const source = new TerrainRigSource({
      heights: new Float32Array(32 * 32).fill(20),
      width: 32,
      height: 32,
      terrainWidth: 100,
    });
    const animation = new TerrainOrbitRig({
      targetXZ: [50, 50],
      duration: 1,
      radius: 10,
      phiStartDeg: 0,
      phiEndDeg: 0,
      thetaStartDeg: 90,
      clearance: new TerrainClearance({ minimumHeight: 5 }),
    }).bake(source, { samplesPerSecond: 4 });
    const state = animation.evaluate(0.5)!;
    expect(Math.abs(cameraStateEye(state)[1] - 5)).toBeLessThan(1e-3);
    expect(state.radius).toBeGreaterThan(10);
  });

  it("refines around clearance hotspots and large sweeps", () => {
    const heights = new Float32Array(64 * 64);
    for (let col = 31; col < 34; col += 1) heights[44 * 64 + col] = 30;
    const source = new TerrainRigSource({ heights, width: 64, height: 64, terrainWidth: 100 });
    const hotspot = new TerrainOrbitRig({
      targetXZ: [50, 50],
      duration: 1,
      radius: 20,
      phiStartDeg: 0,
      phiEndDeg: 180,
      thetaStartDeg: 90,
      clearance: { minimumHeight: 5, maxRefinePasses: 8 },
    }).bake(source, { samplesPerSecond: 1 });
    expect(hotspot.keyframeCount).toBeGreaterThan(2);
    for (const [end, mid] of [[270, 135], [720, 360]] as const) {
      const sweep = new TerrainOrbitRig({
        targetXZ: [50, 50],
        duration: 1,
        radius: 20,
        phiStartDeg: 0,
        phiEndDeg: end,
        thetaStartDeg: 60,
      }).bake(flat(), { samplesPerSecond: 1 });
      expect(Math.abs(sweep.getKeyframes().at(-1)!.phiDeg - end)).toBeLessThan(1e-3);
      expect(Math.abs(sweep.evaluate(0.5)!.phiDeg - mid)).toBeLessThanOrEqual(1);
    }
  });

  it("rail rig keeps a forward target at and beyond the terrain boundary", () => {
    const end = new TerrainRailRig({
      pathXZ: [[10, 10], [90, 10]],
      duration: 1,
      cameraHeightOffset: 0,
      lookAheadDistance: 20,
    }).bake(flat(), { samplesPerSecond: 4 });
    const final = end.evaluate(1)!;
    expect(final.target![0]).toBeCloseTo(100, 4);
    expect(cameraStateEye(final)[0]).toBeCloseTo(90, 4);
    const boundary = new TerrainRailRig({
      pathXZ: [[10, 10], [100, 10]],
      duration: 1,
      cameraHeightOffset: 0,
      lookAheadDistance: 20,
    }).bake(flat(), { samplesPerSecond: 4 });
    const last = boundary.evaluate(1)!;
    expect(last.target![0]).toBeCloseTo(100, 4);
    expect(cameraStateEye(last)[0]).toBeLessThan(100);
  });

  it("validates paths, bounds, polar angles and bake rate with native wording", () => {
    const errors = nativeFixture.rigErrors;
    expect(
      () => new TerrainRailRig({ pathXZ: [[10, 10], [10, 10]], duration: 1, cameraHeightOffset: 5, lookAheadDistance: 1 }),
    ).toThrow(browserMessage(errors.uniquePoints));
    expect(() =>
      new TerrainTargetFollowRig({ targetPathXZ: [[10, 10], [120, 10]], duration: 1, radius: 10 }).bake(flat(), {
        samplesPerSecond: 4,
      }),
    ).toThrow(browserMessage(errors.terrainBounds));
    expect(
      () => new TerrainOrbitRig({ targetXZ: [50, 50], duration: 1, radius: 10, phiStartDeg: 0, phiEndDeg: 90, thetaStartDeg: 180 }),
    ).toThrow(browserMessage(errors.polarAngle));
    expect(() =>
      new TerrainOrbitRig({ targetXZ: [50, 50], duration: 1, radius: 10, phiStartDeg: 0, phiEndDeg: 90 }).bake(flat(), {
        samplesPerSecond: 0,
      }),
    ).toThrow(browserMessage(errors.samplesPerSecond));
    expect(
      () => new TerrainOrbitRig({ targetXZ: [50, 50], duration: 1, radius: 10, phiStartDeg: 0, phiEndDeg: 90, thetaEndDeg: 180 }),
    ).toThrow(/\[0, 180\)/);
    expect(
      () => new TerrainTargetFollowRig({ targetPathXZ: [[10, 10], [20, 10]], duration: 1, radius: 10, thetaDeg: 180 }),
    ).toThrow(/\[0, 180\)/);
    expect(
      () =>
        new TerrainOrbitRig({
          targetXZ: [50, 50],
          duration: 1,
          radius: 10,
          phiStartDeg: 0,
          phiEndDeg: 90,
          clearance: null as unknown as undefined,
        }),
    ).toThrow(/TerrainClearance/);
    expect(() => new TerrainClearance({ minimumHeight: -1 })).toThrow(/minimumHeight/);
    expect(() => new TerrainOrbitRig({ targetXZ: [50, 50], duration: 1, radius: 10, phiStartDeg: 0, phiEndDeg: 90 }).bake({} as TerrainRigSource)).toThrow(/TerrainRigSource/);
  });

  it("accepts rig-generated keyframes in replaceKeyframes", () => {
    const animation = new TerrainOrbitRig({
      targetXZ: [50, 50],
      duration: 1,
      radius: 20,
      phiStartDeg: 0,
      phiEndDeg: 90,
    }).bake(flat(), { samplesPerSecond: 4 });
    const keyframes = animation.getKeyframes();
    animation.replaceKeyframes([
      ...keyframes,
      new CameraKeyframe({ time: 1.5, phiDeg: 120, thetaDeg: 60, radius: 25, fovDeg: 55, target: [50, 0, 50] }),
    ]);
    expect(animation.keyframeCount).toBe(keyframes.length + 1);
    expect(animation.getKeyframes().at(-1)!.time).toBe(1.5);
  });
});

describe("C04 clearance-clamped playback", () => {
  it("never violates the minimum at any playback time", () => {
    for (const scenario of nativeFixture.rigs as Scenario[]) {
      const source = sourceFor(scenario);
      const rig = rigFor(scenario);
      const animation = rig.bake(source, { samplesPerSecond: scenario.samplesPerSecond });
      const minimum = rig.clearance.minimumHeight;
      // 997 Hz is coprime with every verification rate, so it probes the
      // spans between the dense verification samples.
      const steps = Math.ceil(animation.duration * 997);
      for (let index = 0; index <= steps; index += 1) {
        const time = index / 997;
        const pose = source.eyeAt(animation, time, { minimumHeight: minimum })!;
        expect(pose.eye[1]).toBeGreaterThanOrEqual(source.heightAt(pose.eye[0], pose.eye[2]) + minimum);
        const raw = cameraStateEye(animation.evaluate(time)!);
        // The clamp only ever lifts the raw native eye.
        expect(pose.eye[0]).toBe(raw[0]);
        expect(pose.eye[2]).toBe(raw[2]);
        expect(pose.eye[1]).toBeGreaterThanOrEqual(raw[1]);
      }
      const camera = rig.cameraAt(source, animation, animation.duration / 2, { near: 0.5, far: 900 })!;
      expect(camera).toMatchObject({ near: 0.5, far: 900 });
    }
    expect(flat().eyeAt(new CameraAnimation(), 0)).toBeUndefined();
    const untargeted = new CameraAnimation([{ time: 0, phiDeg: 0, thetaDeg: 45, radius: 5, fovDeg: 50 }]);
    expect(() => flat().eyeAt(untargeted, 0)).toThrow(/target-aware/);
    expect(() => flat().eyeAt(untargeted, 0, { minimumHeight: -1 })).toThrow();
  });
});

describe("C04 rig sources, serialization and world mapping", () => {
  it("fills nodata, samples bilinearly and sizes viewer orbits", () => {
    const source = new TerrainRigSource({ heights: [1, Number.NaN, 3, 5], width: 2, height: 2, zScale: 2, terrainWidth: 10 });
    expect(source.minHeight).toBe(1);
    expect(source.heightAt(10, 0)).toBe(0);
    expect(source.heightAt(5, 5)).toBeCloseTo((0 + 0 + 4 + 8) / 4, 10);
    expect(viewerOrbitRadius(10)).toBeCloseTo(19, 10);
    expect(viewerOrbitRadius(source, { scale: 0.1 })).toBe(5);
    expect(() => new TerrainRigSource({ heights: [Number.NaN], width: 1, height: 1 })).toThrow(/finite sample/);
    expect(() => new TerrainRigSource({ heights: [0, 0, 0], width: 2, height: 2 })).toThrow(/width \* height/);
    expect(() => new TerrainRigSource({ heights: [0], width: 1, height: 1, zScale: 0 })).toThrow(/zScale/);
  });

  it("round-trips rigs through JSON and rebakes identically", () => {
    for (const scenario of (nativeFixture.rigs as Scenario[]).slice(0, 4)) {
      const rig = rigFor(scenario);
      const json = JSON.parse(JSON.stringify(rig.toJSON()));
      const restored = terrainRigFromJSON(json);
      expect(restored.toJSON()).toEqual(rig.toJSON());
      const source = sourceFor(scenario);
      expect(JSON.stringify(restored.bake(source, { samplesPerSecond: scenario.samplesPerSecond }))).toBe(
        JSON.stringify(rig.bake(source, { samplesPerSecond: scenario.samplesPerSecond })),
      );
    }
    expect(() => terrainRigFromJSON({ kind: "spiral", version: 1, options: {} } as never)).toThrow(/kind/);
  });

  it("maps contract space onto a TerrainDataset's renderer world space", () => {
    const width = 33;
    const height = 17;
    const heights = new Float32Array(width * height);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        heights[row * width + col] = 100 + row * 2 + col;
      }
    }
    heights[5] = -9999;
    const dataset = TerrainDataset.fromArray({
      width,
      height,
      heights,
      spacing: [30, 30],
      exaggeration: 2,
      nodata: -9999,
    });
    const source = TerrainRigSource.fromDataset(dataset);
    expect(source.terrainWidth).toBe(960);
    expect(source.zScale).toBe(2);
    // Grid corners land on the renderer's centered physical extent.
    expect(source.toWorld([0, 0, 0])).toEqual([-480, (100 - dataset.domain[0]) * 2, -240]);
    const corner = source.toWorld([960, 10, 960]);
    expect(corner[0]).toBeCloseTo(480, 9);
    expect(corner[2]).toBeCloseTo(240, 9);
    const animation = new TerrainOrbitRig({
      targetXZ: [480, 480],
      duration: 1,
      radius: 150,
      phiStartDeg: 0,
      phiEndDeg: 120,
      thetaStartDeg: 55,
      clearance: { minimumHeight: 10 },
    }).bake(source, { samplesPerSecond: 8 });
    for (const time of [0, 0.25, 0.5, 1]) {
      const camera = source.cameraAt(animation, time, { near: 1, far: 5000 })!;
      const state = animation.evaluate(time)!;
      const contractEye = cameraStateEye(state);
      // The renderer-space eye keeps its terrain sample and clearance.
      const [row, col] = source.contractToPixel(contractEye[0], contractEye[2]);
      expect(camera.position[0]).toBeCloseTo(col * 30 - 480, 6);
      expect(camera.position[2]).toBeCloseTo(row * 30 - 240, 6);
      const groundWorld = source.toWorld([contractEye[0], source.heightAt(contractEye[0], contractEye[2]), contractEye[2]]);
      expect(camera.position[1] - groundWorld[1]).toBeGreaterThanOrEqual(10 - 1e-3);
    }
    expect(source.cameraAt(new CameraAnimation(), 0)).toBeUndefined();
  });
});
