import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

import { runViewerBenchmarkInBrowser } from "./viewer-benchmark-browser.js";

const trace = { id: "forge3d-viewer-benchmark-trace-v1", warmup: [], measurement: [] };
for (let index = 0; index < 120; index += 1) trace.warmup.push({ yawDegrees: index });
for (let index = 0; index < 600; index += 1) trace.measurement.push({ yawDegrees: index });
const assets = new Map([
  ["/manifest.json", Buffer.from(JSON.stringify({ id: "forge3d-viewer-benchmark-v1", traceVersion: 1 }))],
  ["/terrain.bin", Buffer.alloc(512 * 512 * 4)],
  ["/trace.json", Buffer.from(JSON.stringify(trace))],
]);
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<canvas id="viewer"></canvas>');
    return;
  }
  const body = assets.get(request.url);
  response.writeHead(body ? 200 : 404, { "Content-Type": request.url?.endsWith(".json") ? "application/json" : "application/octet-stream" });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const address = server.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${address.port}`;
  await page.goto(origin);
  await page.evaluate(() => {
    const canvas = document.querySelector("#viewer");
    let submittedFrames = 0;
    let renderRequests = 0;
    let ownedAnimationFrameCount = 0;
    const schedule = () => {
      renderRequests += 1;
      if (ownedAnimationFrameCount > 0) return;
      ownedAnimationFrameCount = 1;
      requestAnimationFrame(() => { ownedAnimationFrameCount = 0; submittedFrames += 1; });
    };
    const viewer = {
      resize: ({ width, height, devicePixelRatio }) => { canvas.width = width * devicePixelRatio; canvas.height = height * devicePixelRatio; schedule(); },
      setTerrain: schedule,
      setView: schedule,
      getDiagnostics: () => ({ renderRequests, submittedFrames, skippedFrames: 0,
        pendingAnimationFrame: ownedAnimationFrameCount > 0, ownedAnimationFrameCount }),
      dispose: () => undefined,
    };
    window.__forge3dInteractiveViewer = { canvas, create: async () => viewer };
  });
  const result = await page.evaluate(runViewerBenchmarkInBrowser, {
    environment: { browserZoom: 1 }, includeSchedulingEvidence: true,
    assetUrls: { manifest: `${origin}/manifest.json`, terrain: `${origin}/terrain.bin`, trace: `${origin}/trace.json` },
  });
  assert.equal(result.rafTimestampsMs.length, 601);
  assert.equal(result.submittedFramesDelta, 600);
  assert.equal(result.scheduling.maxOutstandingFrames, 1);
  assert.equal(result.scheduling.finalOutstandingFrames, 0);
  console.log("local Playwright loopback page.evaluate benchmark smoke passed");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
