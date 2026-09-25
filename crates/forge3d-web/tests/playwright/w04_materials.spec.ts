import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04Probe: () => Promise<any>;
    __forge3dW04FalloffProbe: (cases: unknown[]) => Promise<any>;
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

// Native attenuation, written out independently of the runtime:
// 1f4084a:src/shaders/lighting.wgsl (inverse square with a range window) and
// src/shaders/soft_light_radius.wgsl (soft curves and the edge smoothstep).
function nativeFalloff(d: number, light: Record<string, any>): number {
  const range: number = light.range;
  const mode: string = light.falloff ?? "inverse-square";
  if (mode === "inverse-square") {
    const ratio = Math.min(Math.max(d / Math.max(range, 1e-4), 0), 1);
    return (1 - ratio * ratio) / Math.max(d * d, 1e-4);
  }
  const inner: number = light.innerRadius ?? 0;
  const exponent: number = light.falloffExponent ?? 2;
  const soft: number = light.edgeSoftness ?? 0;
  if (d >= range) return 0;
  let falloff = 1;
  if (d > inner) {
    const t = (d - inner) / (range - inner);
    falloff =
      mode === "linear" ? 1 - t
      : mode === "quadratic" ? Math.pow(1 - t, exponent)
      : mode === "cubic" ? 1 - t * t * t
      : Math.exp(-exponent * t);
  }
  if (soft > 0) {
    const e0 = range + soft;
    const e1 = inner - soft;
    const s = Math.min(Math.max((d - e0) / (e1 - e0), 0), 1);
    falloff *= s * s * (3 - 2 * s);
  }
  return falloff;
}

test("W04 point-light falloff matches the native attenuation curves", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const lights = [
    { range: 10 },
    { range: 6, falloff: "linear", innerRadius: 1 },
    { range: 6, falloff: "quadratic", falloffExponent: 1.5, innerRadius: 0.5 },
    { range: 6, falloff: "quadratic", falloffExponent: 2.5 },
    { range: 6, falloff: "cubic", innerRadius: 1 },
    { range: 6, falloff: "exponential", falloffExponent: 3 },
    { range: 5, falloff: "linear", innerRadius: 1, edgeSoftness: 1.5 },
  ];
  const cases = lights.flatMap((light) =>
    [2, 3, 4].map((height) => ({ light, height })),
  );
  await page.goto("/examples/test-w04-materials.html");
  const result = await page.evaluate((input) => window.__forge3dW04FalloffProbe(input), cases);
  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  // L - ambient = K * falloff(d) with one K (Lambert albedo * intensity) for
  // every mode and distance.
  const scales = result.results.map((entry: any) => entry.direct / nativeFalloff(entry.height, entry.light));
  const reference = scales[0];
  expect(reference).toBeGreaterThan(0);
  for (const [index, scale] of scales.entries()) {
    const entry = result.results[index];
    expect(
      Math.abs(scale / reference - 1),
      `${entry.light.falloff ?? "inverse-square"} at d=${entry.height}`,
    ).toBeLessThan(0.01);
  }
});
