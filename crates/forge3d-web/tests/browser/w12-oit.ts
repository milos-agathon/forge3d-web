import type { Page } from "@playwright/test";
import { expect } from "./webgpu-fixture";

export function expectVectorOit(report: any, requested: string, available: boolean, context?: string) {
    const optional = requested === "auto" || requested === "dual-source";
    expect(report.requestedOit, context).toBe(requested);
    expect(report.effectiveOit, context).toBe(optional ? available ? "dual-source" : "wboit" : requested);
    expect(report.fallbackReason, context).toBe(optional && !available ? "dual-source-blending-unavailable" : null);
}

export async function maskDualSource(page: Page) {
    await page.addInitScript(() => {
        const gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu);
        gpu.requestAdapter = async options => {
            const adapter = await request(options);
            if (adapter) Object.defineProperty(adapter, "features", {
                value: new Set([...adapter.features].filter(feature => feature !== "dual-source-blending")),
            });
            return adapter;
        };
    });
    await page.reload();
}
