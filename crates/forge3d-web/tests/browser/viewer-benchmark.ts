import type { Page } from "@playwright/test";

import { runViewerBenchmarkInBrowser } from "./viewer-benchmark-browser.js";

export interface BenchmarkEnvironmentSignals {
  browserZoom: number;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unavailable";
  thermalSignalProvenance?: string;
  lowPowerMode?: boolean | "unavailable";
  lowPowerSignalProvenance?: string;
}

export async function runViewerBenchmark(
  page: Page,
  signals: BenchmarkEnvironmentSignals,
) {
  const benchmark = new URL("/tests/browser/benchmark/", page.url());
  return page.evaluate(runViewerBenchmarkInBrowser, {
    environment: signals,
    assetUrls: {
      manifest: new URL("benchmark-manifest-v1.json", benchmark).href,
      terrain: new URL("benchmark-terrain-v1.f32le", benchmark).href,
      trace: new URL("benchmark-trace-v1.json", benchmark).href,
    },
  });
}
