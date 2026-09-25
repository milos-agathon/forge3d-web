import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04LifecycleProbe: () => Promise<any>;
  }
}

test("W04 lifecycle: atomic scene commits, camera validation, recovery replay", async ({
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

  await page.goto("/examples/test-w04-lifecycle.html");
  const result = await page.evaluate(() => window.__forge3dW04LifecycleProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.initial.currentBytes).toBeGreaterThan(0);
  expect(result.initial.effectiveMapSize).toBe(256);
  expect(result.initial.filter).toBe("hard");

  expect(result.oversized.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  expect(result.oversizedUnchanged.memory).toBe(true);
  expect(result.oversizedUnchanged.shadow).toBe(true);
  expect(result.oversizedUnchanged.frame).toBe(true);

  expect(result.malformed.code).toBe("INVALID_INPUT");
  expect(result.malformedUnchanged.memory).toBe(true);
  expect(result.malformedUnchanged.shadow).toBe(true);
  expect(result.malformedUnchanged.frame).toBe(true);

  expect(result.cameraRejection.code).toBe("INVALID_INPUT");
  expect(result.cameraUnchanged).toBe(true);

  expect(result.empty.applied).toBe(true);
  expect(result.empty.shadowReason).toBe("shadows disabled");
  expect(result.empty.csmEnabled).toBe(false);

  expect(result.cycles.count).toBe(30);
  expect(result.cycles.peakLoaded).toBeGreaterThan(result.cycles.baseline);
  expect(result.cycles.allReturned).toBe(true);
  expect(result.cycles.allocationCount).toBe(
    result.cycles.baselineAllocationCount,
  );

  expect(result.recovery.status).toBe("ready");
  expect(result.recovery.generations).toBe(2);
  expect(result.recovery.byteEqual).toBe(true);
  expect(result.recovery.setSceneCalls).toBe(1);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
