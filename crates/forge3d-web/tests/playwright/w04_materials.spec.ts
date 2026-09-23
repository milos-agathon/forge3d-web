import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04Probe: () => Promise<any>;
  }
}

test("W04 textured materials render, BRDF switch, and loss recovery", async ({
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

  await page.goto("/examples/test-w04-materials.html");
  const result = await page.evaluate(() => window.__forge3dW04Probe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.cpu.tangent[0]).toBeCloseTo(1, 5);
  expect(result.cpu.tangent[1]).toBeCloseTo(0, 5);
  expect(result.cpu.tangent[2]).toBeCloseTo(0, 5);
  expect(Math.abs(result.cpu.tangent[3])).toBeCloseTo(1, 5);
  expect(result.cpu.occlusion).toEqual([10, 40, 70, 100]);
  expect(result.cpu.roughness).toEqual([20, 50, 80, 110]);
  expect(result.cpu.metallic).toEqual([30, 60, 90, 120]);

  expect(result.rgbaBytes).toBe(160 * 120 * 4);
  expect(result.textured.changedFraction).toBeGreaterThanOrEqual(0.1);
  expect(result.textured.maxChannelDelta).toBeGreaterThanOrEqual(1);
  expect(result.brdf.maxChannelDelta).toBeGreaterThanOrEqual(1);
  expect(result.nearestSampler.bytes).toBe(160 * 120 * 4);
  expect(result.nearestSampler.nonzero).toBe(true);

  expect(result.texturePayloadBytes).toBe(100);
  expect(result.memory.sessionIncrease).toBeGreaterThan(0);
  expect(result.memory.sessionIncrease).toBeLessThanOrEqual(
    result.texturePayloadBytes + 262_144,
  );
  expect(result.memory.nativeTexturesBefore).toBeGreaterThanOrEqual(
    result.texturePayloadBytes,
  );
  expect(result.memory.nativeTexturesAfter).toBeGreaterThanOrEqual(
    result.texturePayloadBytes,
  );

  expect(result.recovered.status).toBe("ready");
  expect(result.recovered.generations).toBe(2);
  expect(result.recovered.byteEqual).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
