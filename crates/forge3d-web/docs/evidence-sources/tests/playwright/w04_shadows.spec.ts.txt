import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04ShadowsProbe: () => Promise<any>;
  }
}

test("W04 shadows: six filters, CSM, stabilization, and loss recovery", async ({
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

  await page.goto("/examples/test-w04-shadows.html");
  const result = await page.evaluate(() => window.__forge3dW04ShadowsProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.csmFilterRejection.code).toBe("INVALID_INPUT");
  expect(result.csmFilterRejection.message).toContain(
    "cascade pipeline, not a shadow filter",
  );
  expect(result.csmObjectValid).toBe(true);

  const filters = result.filters;
  const names = ["hard", "pcf", "pcss", "vsm", "evsm", "msm"];
  for (const name of names) {
    const entry = filters[name];
    expect(entry.nonconstant).toBeGreaterThan(0);
    expect(entry.shadowFraction).toBeGreaterThan(0);
    expect(entry.report.requestedFilter).toBe(name);
    expect(entry.report.effectiveFilter).toBe(name);
    expect(entry.report.effectiveMapSize).toBe(256);
    expect(entry.report.csmEnabled).toBe(true);
    expect(entry.report.cascadeCount).toBe(3);
    expect(entry.report.casterLightId).not.toBeNull();
    expect(entry.report.momentFormat).toBe(
      name === "vsm" || name === "evsm" || name === "msm"
        ? "rgba32float"
        : "none",
    );
  }
  for (let index = 1; index < names.length; index += 1) {
    expect(filters[names[index]].adjacentChange.changedFraction).toBeGreaterThan(
      0,
    );
  }

  expect(result.memory.sessionIncrease).toBeGreaterThan(0);
  expect(result.memory.sessionIncrease).toBeLessThanOrEqual(
    result.memory.expectedMax,
  );

  expect(result.csm.cascadeCount).toBe(3);
  expect(result.csm.tintCategories).toBeGreaterThanOrEqual(2);

  expect(result.stabilization.subTexel.changedFraction).toBeLessThanOrEqual(
    0.02,
  );
  expect(result.stabilization.overTexel.changedFraction).toBeGreaterThan(0);

  expect(result.peterPanning.safe).toBe(true);
  expect(result.peterPanning.contactGap).toBeLessThanOrEqual(2);

  expect(result.recovered.status).toBe("ready");
  expect(result.recovered.generations).toBe(2);
  expect(result.recovered.byteEqual).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
