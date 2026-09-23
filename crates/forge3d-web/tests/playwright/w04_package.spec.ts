import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04PackageProbe: () => Promise<any>;
  }
}

test("W04 public-API consumer: lights, materials, IBL, shadows, assets", async ({
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

  await page.goto("/examples/test-w04-package.html");
  const result = await page.evaluate(() => window.__forge3dW04PackageProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.rgbaBytes).toBe(160 * 120 * 4);
  expect(result.distinctPixels).toBeGreaterThan(8);
  expect(result.lightingChange).toBeGreaterThan(0.1);

  expect(result.shadow.requestedFilter).toBe("pcf");
  expect(result.shadow.effectiveFilter).toBe("pcf");
  expect(result.shadow.csmEnabled).toBe(true);
  expect(result.shadow.cascadeCount).toBe(2);
  expect(result.shadow.casterLightId).not.toBeNull();
  expect(result.ibl.effectiveMode).toBe("prepared-upload");
  expect(result.memory.currentBytes).toBeGreaterThan(0);
  // Disabled shadows render no cascades, so the report must not claim CSM.
  expect(result.disabledShadow.reason).toBe("shadows disabled");
  expect(result.disabledShadow.csmEnabled).toBe(false);
  expect(result.disabledShadow.cascadeCount).toBe(1);
  expect(result.disabledShadow.casterLightId).toBeNull();

  expect(result.routes.map((route: any) => route.implementation)).toEqual([
    "alias",
    "approximation",
    "exact",
  ]);
  expect(result.preset).toBe("point");
  expect(result.csmRejection.code).toBe("INVALID_INPUT");

  expect(result.basisAsset.status).toBe(200);
  expect(result.basisAsset.bytes).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
