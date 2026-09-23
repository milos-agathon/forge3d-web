import { describe, expect, it } from "vitest";

import {
  apertureToFStop,
  Camera,
  cameraDofParams,
  circleOfConfusion,
  cloneCameraInput,
  composeTrs,
  depthOfFieldRange,
  fStopToAperture,
  hyperfocalDistance,
  invertMatrix,
  lookAt,
  lookAtTransform,
  makeCamera,
  mat4FromRows,
  mat4ToRows,
  multiplyMatrices,
  normalMatrix,
  orthographic,
  perspective,
  rotateX,
  rotateY,
  rotateZ,
  scale,
  scaleUniform,
  screenRay,
  screenToWorld,
  translate,
  validateCameraInput,
  viewProjection,
  worldToScreen,
} from "../../src-ts/camera.js";
import type { CameraInput, ClipSpace, Vec3 } from "../../src-ts/index.js";
import {
  browserMessage,
  expectClose,
  expectRowsClose,
  nativeFixture,
} from "./w05-fixture.js";

const projection = nativeFixture.projection;
const transforms = nativeFixture.transforms;
const dof = nativeFixture.dof;

function expectInvalid(action: () => unknown, message: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected INVALID_INPUT containing "${message}"`).toBeDefined();
  expect((caught as { code?: string }).code).toBe("INVALID_INPUT");
  expect((caught as Error).message).toContain(message);
}

describe("C01 projection matrices match the native oracle within 1e-5", () => {
  it("look-at", () => {
    for (const item of projection.lookAt) {
      if (item.error !== undefined) {
        expectInvalid(() => lookAt(item.eye, item.target, item.up), item.error);
        continue;
      }
      expectRowsClose(lookAt(item.eye, item.target, item.up), item.matrix, "lookAt");
    }
  });

  it("perspective in WebGPU and GL clip space", () => {
    expect(projection.perspective.length).toBe(10);
    for (const item of projection.perspective) {
      expectRowsClose(
        perspective(item.fovYDegrees, item.aspect, item.near, item.far, item.clipSpace as ClipSpace),
        item.matrix,
        `perspective(${item.fovYDegrees}, ${item.clipSpace})`,
      );
    }
  });

  it("orthographic in WebGPU and GL clip space", () => {
    for (const item of projection.orthographic) {
      expectRowsClose(
        orthographic(item.left, item.right, item.bottom, item.top, item.near, item.far, item.clipSpace as ClipSpace),
        item.matrix,
        "orthographic",
      );
    }
  });

  it("view-projection", () => {
    for (const item of projection.viewProjection) {
      expectRowsClose(
        viewProjection(item.eye, item.target, item.up, item.fovYDegrees, item.aspect, item.near, item.far, item.clipSpace as ClipSpace),
        item.matrix,
        "viewProjection",
      );
    }
  });

  it("keeps native validation wording with browser parameter names", () => {
    const errors = projection.errors;
    expectInvalid(() => perspective(180, 1, 0.1, 10), browserMessage(errors.fovy));
    expectInvalid(() => perspective(45, 1, 0, 10), browserMessage(errors.near));
    expectInvalid(() => perspective(45, 1, 1, 1), browserMessage(errors.far));
    expectInvalid(() => perspective(45, 0, 0.1, 10), browserMessage(errors.aspect));
    expectInvalid(() => perspective(45, 1, 0.1, 10, "dx" as ClipSpace), browserMessage(errors.clipSpace));
    expectInvalid(() => lookAt([0, Number.NaN, 0], [0, 0, -1], [0, 1, 0]), browserMessage(errors.vectorFinite));
    expectInvalid(() => lookAt([0, 0, 0], [0, 5, 0], [0, 1, 0]), browserMessage(errors.upColinear));
    expectInvalid(() => orthographic(1, 1, -1, 1, 0.1, 10), browserMessage(errors.orthoLeftRight));
    expectInvalid(() => orthographic(-1, 1, 2, 1, 0.1, 10), browserMessage(errors.orthoBottomTop));
  });
});

describe("C01 transforms match the native oracle within 1e-5", () => {
  it("translate, rotate, scale and TRS composition", () => {
    for (const item of transforms.translate) {
      expectRowsClose(translate(item.args[0], item.args[1], item.args[2]), item.matrix, "translate");
    }
    for (const [key, fn] of [
      ["rotateX", rotateX],
      ["rotateY", rotateY],
      ["rotateZ", rotateZ],
    ] as const) {
      for (const item of transforms[key]) {
        expectRowsClose(fn(item.degrees), item.matrix, `${key}(${item.degrees})`);
      }
    }
    for (const item of transforms.scale) {
      expectRowsClose(scale(item.args[0], item.args[1], item.args[2]), item.matrix, "scale");
    }
    for (const item of transforms.scaleUniform) {
      expectRowsClose(scaleUniform(item.s), item.matrix, "scaleUniform");
    }
    for (const item of transforms.composeTrs) {
      expectRowsClose(composeTrs(item.translation, item.rotationDegrees, item.scale), item.matrix, "composeTrs");
    }
    for (const item of transforms.lookAtTransform) {
      expectRowsClose(lookAtTransform(item.position, item.target, item.up), item.matrix, "lookAtTransform");
    }
  });

  it("multiply, invert and normal matrix", () => {
    for (const item of transforms.multiply) {
      expectRowsClose(
        multiplyMatrices(mat4FromRows(item.left), mat4FromRows(item.right)),
        item.matrix,
        "multiply",
      );
    }
    for (const item of transforms.invert) {
      expectRowsClose(invertMatrix(mat4FromRows(item.input)), item.matrix, "invert");
    }
    for (const item of transforms.normalMatrix) {
      expectRowsClose(normalMatrix(mat4FromRows(item.input)), item.matrix, "normalMatrix");
    }
    expectInvalid(() => invertMatrix(new Float32Array(16)), "invertible");
    expectInvalid(() => normalMatrix(scale(1, 0, 1)), "invertible");
    expectInvalid(() => multiplyMatrices(new Float32Array(15), new Float32Array(16)), "16-element");
  });

  it("round-trips the native row-major layout", () => {
    const matrix = composeTrs([1, 2, 3], [10, 20, 30], [1, 2, 0.5]);
    expect(Array.from(mat4FromRows(mat4ToRows(matrix)))).toEqual(Array.from(matrix));
    expect(mat4ToRows(translate(4, 5, 6))[0]).toEqual([1, 0, 0, 4]);
  });
});

describe("C01 depth-of-field helpers match the native oracle", () => {
  it("computes f-stop, hyperfocal, DOF range and circle of confusion", () => {
    for (const item of dof.fStopToAperture) {
      expectClose(fStopToAperture(item.fStop), item.value, "fStopToAperture");
    }
    for (const item of dof.apertureToFStop) {
      expectClose(apertureToFStop(item.aperture), item.value, "apertureToFStop");
    }
    for (const item of dof.hyperfocal) {
      expectClose(hyperfocalDistance(item.focalLength, item.fStop, item.circleOfConfusion), item.value, "hyperfocal");
    }
    for (const item of dof.depthOfFieldRange) {
      const range = depthOfFieldRange(item.focalLength, item.fStop, item.focusDistance, item.circleOfConfusion);
      expectClose(range.near, item.value[0], "dof near");
      if (item.value[1] === null) {
        expect(range.far).toBe(Infinity);
      } else {
        expectClose(range.far, item.value[1], "dof far");
      }
    }
    for (const item of dof.circleOfConfusion) {
      expectClose(
        circleOfConfusion(item.depth, item.focalLength, item.aperture, item.focusDistance, item.sensorSize),
        item.value,
        "circleOfConfusion",
      );
    }
    const params = cameraDofParams({ aperture: 2.8, focusDistance: 10, focalLength: 50, autoFocus: true, autoFocusSpeed: 3.5 });
    expectClose(params.aperture, dof.dofParams.value[0], "dof aperture");
    expect(params.autoFocus).toBe(dof.dofParams.value[3]);
    expect(cameraDofParams({ aperture: 1, focusDistance: 1, focalLength: 1 }).autoFocusSpeed).toBe(2);
  });

  it("rejects invalid DOF inputs with native wording", () => {
    const errors = dof.errors;
    expectInvalid(() => apertureToFStop(0), browserMessage(errors.aperture));
    expectInvalid(() => fStopToAperture(-1), browserMessage(errors.fStop));
    expectInvalid(() => depthOfFieldRange(50, 2.8, 0), browserMessage(errors.focusDistance));
    expectInvalid(() => hyperfocalDistance(0, 2.8), browserMessage(errors.focalLength));
    expectInvalid(
      () => cameraDofParams({ aperture: 2.8, focusDistance: 10, focalLength: 50, autoFocus: true, autoFocusSpeed: 0 }),
      browserMessage(errors.autoFocusSpeed),
    );
  });
});

describe("Camera", () => {
  const base = { position: [3, 4, 5] as Vec3, target: [0, 0.5, 0] as Vec3, fovYDegrees: 50, near: 0.1, far: 100 };

  it("builds perspective and orthographic projections", () => {
    const camera = new Camera(base);
    expect(camera.projection).toBe("perspective");
    expectRowsClose(
      camera.viewProjectionMatrix(4 / 3),
      mat4ToRows(viewProjection(base.position, base.target, [0, 1, 0], 50, 4 / 3, 0.1, 100)),
      "perspective camera",
    );
    const ortho = camera.with({ projection: "orthographic", orthographicHeight: 8 });
    expectRowsClose(ortho.projectionMatrix(2), mat4ToRows(orthographic(-8, 8, -4, 4, 0.1, 100)), "ortho");
    expect(ortho.toInput()).toMatchObject({ projection: "orthographic", orthographicHeight: 8 });
    expect(ortho.with({ projection: "perspective" }).orthographicHeight).toBeUndefined();
    expect(Object.isFrozen(camera)).toBe(true);
  });

  it("projects world points to pixels and unprojects them back", () => {
    for (const camera of [
      new Camera(base),
      new Camera({ ...base, projection: "orthographic", orthographicHeight: 6 }),
    ]) {
      const viewport = { width: 640, height: 480 };
      const center = camera.worldToScreen(base.target, viewport)!;
      expectClose(center.x, 320, "center x");
      expectClose(center.y, 240, "center y");
      for (const point of [[1, 0, -1], [-2, 1.5, 0.5], [0.25, 3, 1]] as Vec3[]) {
        const projected = camera.worldToScreen(point, viewport)!;
        const back = camera.screenToWorld(projected.x, projected.y, projected.depth, viewport);
        for (let axis = 0; axis < 3; axis += 1) {
          expect(Math.abs(back[axis]! - point[axis]!)).toBeLessThan(1e-9);
        }
        const ray = camera.screenRay(projected.x, projected.y, viewport);
        const toPoint = point.map((value, axis) => value - ray.origin[axis]!);
        const along = toPoint.reduce((sum, value, axis) => sum + value * ray.direction[axis]!, 0);
        const closest = ray.origin.map((value, axis) => value + ray.direction[axis]! * along);
        expect(Math.hypot(...closest.map((value, axis) => value - point[axis]!))).toBeLessThan(1e-9);
      }
    }
    const perspectiveCamera = new Camera(base);
    expect(perspectiveCamera.worldToScreen([6, 8, 10], { width: 10, height: 10 })).toBeUndefined();
    expectInvalid(() => perspectiveCamera.worldToScreen([0, 0, 0], { width: 0, height: 10 }), "viewport");
  });

  it("orthographic rays are parallel to the view direction", () => {
    const camera = new Camera({ ...base, projection: "orthographic", orthographicHeight: 4 });
    const viewport = { width: 100, height: 100 };
    const a = camera.screenRay(0, 0, viewport);
    const b = camera.screenRay(100, 100, viewport);
    for (let axis = 0; axis < 3; axis += 1) {
      expectClose(a.direction[axis]!, camera.forward[axis]!, "ortho ray a");
      expectClose(b.direction[axis]!, camera.forward[axis]!, "ortho ray b");
    }
  });

  it("free functions agree with the Camera helpers", () => {
    const camera = new Camera(base);
    const matrix = camera.viewProjectionMatrix(2);
    const viewport = { width: 200, height: 100 };
    const viaFunction = worldToScreen(matrix, [1, 1, 1], viewport)!;
    const viaCamera = camera.worldToScreen([1, 1, 1], viewport)!;
    expect(Math.abs(viaFunction.x - viaCamera.x)).toBeLessThan(1e-3);
    const inverse = invertMatrix(matrix);
    const world = screenToWorld(inverse, viaFunction.x, viaFunction.y, viaFunction.depth, viewport);
    expect(Math.hypot(world[0] - 1, world[1] - 1, world[2] - 1)).toBeLessThan(1e-3);
    expect(screenRay(inverse, 100, 50, viewport).direction.every(Number.isFinite)).toBe(true);
  });

  it("serializes to versioned JSON", () => {
    const camera = new Camera({ ...base, projection: "orthographic", orthographicHeight: 3 });
    const json = JSON.parse(JSON.stringify(camera));
    expect(json).toMatchObject({ kind: "forge3d.camera", version: 1, orthographicHeight: 3 });
    expect(Camera.fromJSON(json).toInput()).toEqual(camera.toInput());
    expectInvalid(() => Camera.fromJSON({ ...json, kind: "other" }), "kind");
    expectInvalid(() => Camera.fromJSON({ ...json, version: 2 }), "version");
  });
});

describe("validateCameraInput", () => {
  const camera: CameraInput = {
    position: [0, 1, 5],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fovYDegrees: 45,
    near: 0.1,
    far: 100,
  };

  it("accepts perspective and orthographic cameras and detaches arrays", () => {
    const checked = validateCameraInput(camera);
    expect(checked).toEqual(camera);
    expect(checked.position).not.toBe(camera.position);
    expect(validateCameraInput({ ...camera, projection: "orthographic", orthographicHeight: 2 })).toMatchObject({
      projection: "orthographic",
      orthographicHeight: 2,
    });
    expect(cloneCameraInput({ ...camera, projection: "perspective" }).projection).toBe("perspective");
  });

  it("rejects invalid cameras", () => {
    expectInvalid(() => validateCameraInput({ ...camera, position: [0, Number.NaN, 0] }), "camera.position");
    expectInvalid(() => validateCameraInput({ ...camera, up: [0, 0, 0] }), "camera.up");
    expectInvalid(() => validateCameraInput({ ...camera, target: [0, 1, 5] }), "camera.target");
    expectInvalid(() => validateCameraInput({ ...camera, position: [0, 5, 0] }), "colinear");
    expectInvalid(() => validateCameraInput({ ...camera, fovYDegrees: 180 }), "camera.fovYDegrees");
    expectInvalid(() => validateCameraInput({ ...camera, near: 0 }), "camera.near");
    expectInvalid(() => validateCameraInput({ ...camera, far: 0.05 }), "camera.far");
    expectInvalid(
      () => validateCameraInput({ ...camera, projection: "orthographic" }),
      "camera.orthographicHeight",
    );
    expectInvalid(() => validateCameraInput({ ...camera, orthographicHeight: 2 }), "only valid");
    expectInvalid(
      () => validateCameraInput({ ...camera, projection: "fisheye" as "perspective" }),
      "camera.projection",
    );
  });
});

describe("makeCamera", () => {
  it("builds a validated path-tracing camera descriptor", () => {
    const descriptor = makeCamera({ origin: [0, 1, 3], lookAt: [0, 0, 0], up: [0, 1, 0], fovY: 40, aspect: 1.5, exposure: 1 });
    expect(descriptor).toEqual({ origin: [0, 1, 3], lookAt: [0, 0, 0], up: [0, 1, 0], fovY: 40, aspect: 1.5, exposure: 1 });
    expectInvalid(
      () => makeCamera({ origin: [0, 1, 3], lookAt: [0, 0, 0], up: [0, 1, 0], fovY: 40, aspect: 1.5, exposure: 0 }),
      "exposure",
    );
  });
});
