import type { Page } from "@playwright/test";
import type { BenchmarkOptions, BenchmarkResult } from "../../src-ts/benchmark.js";

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

/** FND-07 companion evidence. The frozen v1 scheduling report/assets are unchanged. */
export async function runViewerOperationBenchmark(
  page: Page,
  options: Pick<BenchmarkOptions, 'iterations' | 'warmup' | 'budget' | 'baseline' | 'maxRegressionPercent'> = {},
): Promise<BenchmarkResult> {
  const root = new URL('/tests/browser/benchmark/', page.url());
  return page.evaluate(async ({ apiUrl, manifestUrl, terrainUrl, options }) => {
    const { runBenchmark, pngToArray } = await import(/* @vite-ignore */ apiUrl);
    const fixture = window.__forge3dInteractiveViewer;
    const responses = await Promise.all([fetch(manifestUrl), fetch(terrainUrl)]);
    if (responses.some(r => !r.ok)) throw new Error('FND-07 operation assets unavailable');
    const manifest = await responses[0]!.json(), terrain = await responses[1]!.arrayBuffer();
    if (manifest.id !== 'forge3d-viewer-benchmark-v1') throw new Error('Unexpected FND-07 manifest');
    const terrainDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', terrain))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if (terrainDigest !== manifest.terrainSha256) throw new Error('FND-07 terrain digest mismatch');
    const viewer = await fixture.create({ resize: false, controls: { keyboard: true } });
    try {
      viewer.resize({ width: manifest.canvasCssWidth, height: manifest.canvasCssHeight, devicePixelRatio: manifest.devicePixelRatio });
      viewer.setTerrain({ width: 512, height: 512, heights: new Float32Array(terrain) });
      let captured!: Blob;
      const report = await runBenchmark({
        ...options, op: 'custom', width: manifest.backingWidth, height: manifest.backingHeight,
        operation: async () => { captured = await viewer.screenshot(); },
      });
      const image = await pngToArray(captured);
      if (image.width !== report.width || image.height !== report.height || !image.data.some((v: number, i: number) => v !== image.data[i % 4])) throw new Error('FND-07 operation captured an empty or incorrectly sized image');
      return report;
    } finally { viewer.dispose(); }
  }, {
    apiUrl: new URL('/dist/index.js', page.url()).href,
    manifestUrl: new URL('benchmark-manifest-v1.json', root).href,
    terrainUrl: new URL('benchmark-terrain-v1.f32le', root).href,
    options,
  });
}
