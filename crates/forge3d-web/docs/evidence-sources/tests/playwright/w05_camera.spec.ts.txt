import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW05RenderProbe: () => Promise<any>;
    __forge3dW05ViewerSetup: () => Promise<any>;
    __forge3dW05ViewerState: () => any;
    __forge3dW05ViewerFinish: () => Promise<any>;
  }
}

function trackErrors(page: import("../browser/webgpu-fixture").Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  return { pageErrors, consoleErrors };
}

test("W05 projections, animation frames, rigs, orthographic shadows and loss replay", async ({
  page,
  webgpuAvailability,
}) => {
  // Creates several WebGPU runtimes; each compiles the shared lighting
  // pipelines, which uncached CI GPUs compile slowly.
  test.slow();
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const errors = trackErrors(page);

  await page.goto("/examples/test-w05-camera.html");
  const result = await page.evaluate(() => window.__forge3dW05RenderProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  // C01: GPU silhouettes land where Camera.worldToScreen predicts.
  for (const name of ["orthographic", "perspective"]) {
    const silhouette = result.silhouettes[name];
    expect(silhouette.rendered.count, name).toBeGreaterThan(1000);
    // The outermost covered texel shades to pure black at the grid border,
    // so allow one pixel (plus float noise) against the analytic projection.
    expect(silhouette.maxEdgeError, name).toBeLessThanOrEqual(1.01);
  }
  expect(result.silhouettes.orthographic.rendered.count).toBeGreaterThan(
    result.silhouettes.perspective.rendered.count,
  );

  // Orthographic image is independent of distance; perspective is not.
  expect(result.orthographic.distanceInvariance.mean).toBeLessThan(0.5);
  expect(result.orthographic.perspectiveDistanceChange.mean).toBeGreaterThan(5);
  expect(result.orthographic.coverageRatio).toBeGreaterThan(3.2);
  expect(result.orthographic.coverageRatio).toBeLessThan(4.8);
  expect(result.orthographic.differsFromPerspective).toBeGreaterThan(1);

  // Ported native perspective probes: fov, theta and phi change the frame.
  expect(result.animationFrames.fov).toBeGreaterThan(1);
  expect(result.animationFrames.theta).toBeGreaterThan(1);
  expect(result.animationFrames.phi).toBeGreaterThan(1);
  expect(result.animationFrames.deterministic).toBe(true);

  // C04: rig playback keeps clearance, renders content and is deterministic.
  for (const name of ["orbit", "rail", "follow"]) {
    const rig = result.rigs[name];
    expect(rig.keyframes, name).toBeGreaterThan(2);
    // Playback never violates the minimum, even between the dense
    // verification samples where the raw (native) Catmull-Rom path can dip.
    expect(rig.minClearance, name).toBeGreaterThanOrEqual(rig.minimumHeight - 1e-9);
    expect(Number.isFinite(rig.rawMinClearance), name).toBe(true);
    expect(rig.frames, name).toBeGreaterThan(2);
    expect(rig.blank, name).toBe(0);
    expect(rig.deterministic, name).toBe(true);
  }

  expect(result.orthographicShadows.covered).toBeGreaterThan(1000);
  expect(result.orthographicShadows.csmEnabled).toBe(true);
  expect(result.orthographicShadows.cascadeCount).toBe(3);

  expect(result.invalid).toEqual({
    missingHeight: "INVALID_INPUT",
    strayHeight: "INVALID_INPUT",
    colinearUp: "INVALID_INPUT",
  });

  expect(result.sessionRecovery.status).toBe("ready");
  expect(result.sessionRecovery.generations).toBe(2);
  expect(result.sessionRecovery.camera.projection).toBe("orthographic");
  expect(result.sessionRecovery.byteEqual).toBe(true);

  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test("W05 viewer fly mode: keyboard/pointer switching, replay and recovery", async ({
  page,
  webgpuAvailability,
}) => {
  test.slow();
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const errors = trackErrors(page);

  await page.goto("/examples/test-w05-camera.html");
  const setup = await page.evaluate(() => window.__forge3dW05ViewerSetup());
  expect(setup.supported).toBe(true);
  expect(setup.mode).toBe("orbit");

  const canvas = page.locator("#w05-viewer");
  // Orbit drag first, then switch to fly with the default KeyV binding.
  await canvas.hover();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 70, { steps: 4 });
  await page.mouse.up();
  await canvas.focus();
  await page.keyboard.press("KeyV");
  const flying = await page.evaluate(() => window.__forge3dW05ViewerState());
  expect(flying.mode).toBe("fly");
  // Switching modes keeps the eye in place.
  for (let axis = 0; axis < 3; axis += 1) {
    expect(Math.abs(flying.camera.position[axis] - flying.fly.position[axis])).toBeLessThan(1e-9);
  }

  // Mouse look, then hold W to fly forward over several animation frames.
  await page.mouse.move(box.x + 80, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 50, { steps: 3 });
  await page.mouse.up();
  const looked = await page.evaluate(() => window.__forge3dW05ViewerState());
  expect(looked.fly.yawDegrees).not.toBe(flying.fly.yawDegrees);

  await canvas.focus();
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(400);
  await page.keyboard.up("KeyW");
  const moved = await page.evaluate(() => window.__forge3dW05ViewerState());
  const step = moved.fly.position.map((value: number, axis: number) => value - looked.fly.position[axis]);
  const travelled = Math.hypot(...step);
  expect(travelled).toBeGreaterThan(1);
  // W moves along the (pitched) view direction, like the native FPS camera.
  const forward = [
    Math.cos((looked.fly.pitchDegrees * Math.PI) / 180) * Math.sin((looked.fly.yawDegrees * Math.PI) / 180),
    Math.sin((looked.fly.pitchDegrees * Math.PI) / 180),
    Math.cos((looked.fly.pitchDegrees * Math.PI) / 180) * Math.cos((looked.fly.yawDegrees * Math.PI) / 180),
  ];
  const alignment = step.reduce((sum: number, value: number, axis: number) => sum + value * forward[axis]!, 0) / travelled;
  expect(alignment).toBeGreaterThan(0.999);
  expect(moved.diagnostics.submittedFrames).toBeGreaterThan(looked.diagnostics.submittedFrames);
  await page.keyboard.down("KeyE");
  await page.waitForTimeout(150);
  await page.keyboard.up("KeyE");
  const risen = await page.evaluate(() => window.__forge3dW05ViewerState());
  expect(risen.fly.position[1]).toBeGreaterThan(moved.fly.position[1]);
  expect(risen.fly.position[0]).toBe(moved.fly.position[0]);
  expect(risen.fly.position[2]).toBe(moved.fly.position[2]);
  // Releasing the keys stops the frame loop.
  await page.waitForTimeout(100);
  const idle = await page.evaluate(() => window.__forge3dW05ViewerState());
  expect(idle.diagnostics.ownedAnimationFrameCount).toBe(0);

  const finish = await page.evaluate(() => window.__forge3dW05ViewerFinish());
  expect(finish.error).toBeUndefined();
  expect(finish.ok).toBe(true);
  expect(finish.eventTypes).toEqual(expect.arrayContaining(["key", "look", "orbit", "tick"]));
  expect(finish.replayMode).toBe("fly");
  expect(finish.replayCameraEqual).toBe(true);
  expect(finish.replayScreenshotEqual).toBe(true);
  expect(finish.recovery).toEqual({
    status: "ready",
    mode: "fly",
    cameraEqual: true,
    screenshotEqual: true,
  });
  expect(finish.disposed.ownedListeners).toBe(0);
  expect(finish.disposed.ownedAnimationFrameCount).toBe(0);

  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});
