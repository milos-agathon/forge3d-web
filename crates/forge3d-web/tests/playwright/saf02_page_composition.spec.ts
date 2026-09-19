import { readFileSync } from "node:fs";
import ts from "typescript";

import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

const nonce = "ab".repeat(16);
const basePath = `/runs/10/20/${nonce}/`;
const applicationUrl = `https://app.saf02.test${basePath}`;
const assetUrl = `https://assets.saf02.test${basePath}`;
const packageSha256 = "b".repeat(64);

test("real SAF-02 hardware page continues into generic installed-fixture creation", async ({
  page,
  request,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const facade = await (await request.get("/tests/realm-fixture/a/index.js")).body();
  const bridge = await (await request.get("/tests/realm-fixture/pkg/forge3d_web.js")).body();
  const wasm = await (await request.get("/tests/realm-fixture/runtime.wasm?id=saf02-page")).body();
  const terrain = Buffer.alloc(512 * 512 * 4);
  const rangedTerrain = Buffer.concat([Buffer.alloc(4), terrain]);
  const retryAttempts = new Map<string, number>();
  const modules = new Map([
    ["hardware-page-harness.js", readFileSync(new URL("../browser/hardware-page-harness.js", import.meta.url), "utf8")],
    ["saf02-conformance.js", readFileSync(new URL("../browser/saf02-conformance.js", import.meta.url), "utf8")],
    ["viewer-benchmark-browser.js", readFileSync(new URL("../browser/viewer-benchmark-browser.js", import.meta.url), "utf8")],
    ["chr03-lanes.js", readFileSync(new URL("../../scripts/chr03-lanes.mjs", import.meta.url), "utf8")],
    ["chr04-lanes.js", readFileSync(new URL("../../scripts/chr04-lanes.mjs", import.meta.url), "utf8")],
    ["adapter-attestation.js", ts.transpileModule(
      readFileSync(new URL("../browser/adapter-attestation.ts", import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
    ).outputText],
  ]);

  await page.route("https://app.saf02.test/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const relative = requestUrl.pathname.slice(basePath.length);
    if (relative === "" || relative === "index.html") {
      await route.fulfill({ status: 200, contentType: "text/html", body: pageDocument() });
      return;
    }
    const module = modules.get(relative);
    if (module !== undefined) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: module });
      return;
    }
    if (relative === "node_modules/@forge3d/web/dist/index.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: facade });
      return;
    }
    if (relative === "node_modules/@forge3d/web/pkg/forge3d_web.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: bridge });
      return;
    }
    if (relative === "package.sha256") {
      await route.fulfill({ status: 200, contentType: "text/plain", body: `${packageSha256}\n` });
      return;
    }
    if (relative === "terrain.bin") {
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body: terrain });
      return;
    }
    const retry = relative.match(/^saf02\/retry\/[0-9a-f]{32}\/forge3d_web_bg\.wasm$/u);
    if (retry !== null) {
      const attempt = retryAttempts.get(relative) ?? 0;
      if (route.request().method() === "GET") retryAttempts.set(relative, attempt + 1);
      await route.fulfill({ status: 200, contentType: attempt === 0 ? "application/octet-stream" : "application/wasm", body: wasm });
      return;
    }
    if (relative === "wrong-mime/forge3d_web_bg.wasm") {
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body: wasm });
      return;
    }
    if (relative === "forge3d_web_bg.wasm" || relative === "node_modules/@forge3d/web/dist/forge3d_web_bg.wasm") {
      await route.fulfill({ status: 200, contentType: "application/wasm", body: wasm });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });

  await page.route("https://assets.saf02.test/**", async (route) => {
    const url = new URL(route.request().url());
    const relative = url.pathname.slice(basePath.length);
    const allow = relative.startsWith("cors/allow/");
    const wrongOrigin = relative.startsWith("cors/wrong-origin/");
    const headers: Record<string, string> = {
      "Access-Control-Allow-Origin": allow ? "https://app.saf02.test" : wrongOrigin ? "https://wrong.invalid" : "",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers": "Content-Range,Content-Length",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const body = relative.includes("terrain-range.bin") ? rangedTerrain
      : relative.endsWith("terrain.bin") ? terrain : wasm;
    if (relative.includes("range-416/") && route.request().headers().range) {
      await route.fulfill({ status: 416, headers: { ...headers, "Content-Range": `bytes */${body.length}` } });
      return;
    }
    if (relative.includes("range-exact/") && route.request().headers().range) {
      const range = route.request().headers().range!.match(/^bytes=(\d+)-(\d+)$/u)!;
      const start = Number(range[1]), end = Number(range[2]);
      await route.fulfill({ status: 206, contentType: "application/octet-stream", headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": String(end - start + 1) }, body: body.subarray(start, end + 1) });
      return;
    }
    if (relative === "cors/allow/terrain.bin" && route.request().headers().range === "bytes=1-3") {
      await route.fulfill({ status: 206, contentType: "application/octet-stream", headers: { ...headers, "Content-Range": `bytes 1-3/${body.length}`, "Content-Length": "3" }, body: body.subarray(1, 4) });
      return;
    }
    await route.fulfill({ status: 200, contentType: relative.endsWith(".wasm") ? "application/wasm" : "application/octet-stream", headers, body });
  });

  await page.goto(applicationUrl);
  await page.waitForFunction(() => "__saf02SequenceResult" in window);
  const sequence = await page.evaluate(() => (window as any).__saf02SequenceResult);
  expect(sequence.proof.result).toBe("PASS");
  expect(sequence.routeReadiness.trustedHttps).toBe(true);
  expect(sequence.assertions.passed).toBe(true);
  expect(sequence.selectedUrl).toBe(`${applicationUrl}node_modules/@forge3d/web/dist/forge3d_web_bg.wasm`);
  await page.waitForFunction(() => "__saf02PageResult" in window);
  const hardware = await page.evaluate(() => (window as any).__saf02PageResult);
  expect(hardware.adapter.adapterInfoAvailable).toBe(true);
  if (hardware.adapter.isFallbackAdapter === false) {
    expect(hardware.outcome.kind).toBe("PASS");
    expect(hardware.outcome.value.saf02Proof.result).toBe("PASS");
    expect(hardware.outcome.value.assertions.passed).toBe(true);
  } else if (hardware.adapter.isFallbackAdapter === true) {
    expect(String(hardware.adapter.adapterInfo.architecture).toLowerCase()).toContain("swiftshader");
    expect(hardware.outcome.kind).not.toBe("PASS");
    expect(hardware.outcome).toEqual({
      kind: "REJECTED",
      message: "ATTESTATION_UNAVAILABLE: hardware adapter proof failed",
    });
  } else {
    throw new Error("runHardwarePage returned missing or unknown fallback-adapter provenance");
  }
});

function pageDocument() {
  return `<!doctype html><canvas id="viewer" width="77" height="53"></canvas><script type="module">
const facade=await import("./node_modules/@forge3d/web/dist/index.js");
const canvas=document.querySelector("#viewer"); let viewer;
window.__forge3dHardwareOnError=()=>{};
window.__forge3dInteractiveViewer={canvas,async create(options={}){viewer=await facade.Forge3DViewer.create(canvas,options);viewer.setTerrain({width:2,height:2,heights:new Float32Array([0,1,2,3])});await new Promise(requestAnimationFrame);return viewer;}};
const {runHardwarePage,runInitialViewerAssertions,verifyBrowserRoute,adapterBinding}=await import("./hardware-page-harness.js");
const {runSaf02Conformance}=await import("./saf02-conformance.js");
const {captureAdapterAttestation}=await import("./adapter-attestation.js");
const binding={lane:"safari-macos-m2",assetId:"FW-MAC-M2-01",hostId:"FW-MAC-M2-01",runId:10,jobId:20,commit:"${"a".repeat(40)}",packageSha256:"${packageSha256}"};
const route={applicationUrl:"${applicationUrl}",assetUrl:"${assetUrl}"};
window.__saf02SequenceResult=(async()=>{const proof=await runSaf02Conformance({binding,route,effectiveLaunchArguments:[]});const routeReadiness=await verifyBrowserRoute(route,binding.packageSha256);const assertions=await runInitialViewerAssertions({fixture:window.__forge3dInteractiveViewer,supportAssertions:true,retainViewer:false,onError:window.__forge3dHardwareOnError});const selectedUrl=globalThis[Symbol.for("@forge3d/web.wasm-bridge-coordinator")].record.selectedUrl;return {proof,routeReadiness,assertions,selectedUrl};})();
window.__saf02PageResult=window.__saf02SequenceResult.then(async()=>{const adapter=await captureAdapterAttestation(canvas,adapterBinding(binding),[]);const outcome=await runHardwarePage({lane:"safari-macos-m2",binding,route,effectiveLaunchArguments:[]}).then(value=>({kind:"PASS",value}),error=>({kind:"REJECTED",message:String(error?.message||error)}));return {adapter,outcome};});
</script>`;
}
