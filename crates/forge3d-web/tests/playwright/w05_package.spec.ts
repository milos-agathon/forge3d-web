import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW05PackageProbe: () => Promise<any>;
  }
}

test("W05 public-API consumer: cameras, projections, animation, rigs, replay", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/examples/test-w05-package.html");
  const result = await page.evaluate(() => window.__forge3dW05PackageProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.projection.perspectiveCovered).toBeGreaterThan(1000);
  expect(result.projection.orthographicCovered).toBeGreaterThan(1000);
  expect(result.projection.projectionDiffers).toBeGreaterThan(1);
  expect(result.projection.orthographicDistanceChange).toBeLessThan(0.01);
  expect(result.projection.lastCamera.projection).toBe("orthographic");
  expect(result.math.perspective11).toBeCloseTo(2.4142134, 5);
  expect(result.math.lookAtFinite).toBe(true);
  expect(result.animation.frames).toBe(61);
  expect(result.animation.change).toBeGreaterThan(1);
  expect(result.rig.keyframes).toBeGreaterThan(2);
  expect(result.rig.minClearance).toBeGreaterThanOrEqual(2 - 1e-9);
  expect(result.rig.covered).toBeGreaterThan(100);
  expect(result.replay.equal).toBe(true);
  expect(result.orthographicRejection).toBe("INVALID_INPUT");

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
