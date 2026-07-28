import { expect, test as base } from "@playwright/test";

export interface WebGpuAvailability {
  required: boolean;
  hasNavigatorGpu: boolean;
  adapterAvailable: boolean;
  secureContext: boolean;
  userAgent: string;
}

interface Forge3DFixtures {
  webgpuAvailability: WebGpuAvailability;
}

export const test = base.extend<Forge3DFixtures>({
  webgpuAvailability: async ({ page }, use, testInfo) => {
    const required =
      (
        globalThis as typeof globalThis & {
          process?: { env?: Record<string, string | undefined> };
        }
      ).process?.env?.FORGE3D_WEBGPU_REQUIRED === "1";
    await page.goto("/examples/test-interactive-viewer.html");
    const availability = await page.evaluate(async () => {
      const gpu = navigator.gpu;
      const adapter = gpu ? await gpu.requestAdapter() : null;
      return {
        hasNavigatorGpu: Boolean(gpu),
        adapterAvailable: Boolean(adapter),
        secureContext: window.isSecureContext,
        userAgent: navigator.userAgent,
      };
    });
    const result = { required, ...availability };
    await testInfo.attach("forge3d-webgpu-probe.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    if (required) {
      expect(
        result.hasNavigatorGpu,
        "FORGE3D_WEBGPU_REQUIRED=1 but navigator.gpu is missing",
      ).toBe(true);
      expect(
        result.adapterAvailable,
        "FORGE3D_WEBGPU_REQUIRED=1 but no WebGPU adapter is available",
      ).toBe(true);
    }
    await use(result);
  },
});

export function skipRenderAssertionsWhenProbing(
  availability: WebGpuAvailability,
) {
  test.skip(
    !availability.required &&
      (!availability.hasNavigatorGpu || !availability.adapterAvailable),
    "Probe lane recorded unavailable WebGPU; render assertions are not applicable",
  );
}

export { expect };
