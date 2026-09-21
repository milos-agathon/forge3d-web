export const SAF02_PAGE_TIMEOUT_MS = 110_000;
const OPERATION_TIMEOUT_MS = 8_000;

export async function runSaf02Conformance({ binding, route, effectiveLaunchArguments = [] }) {
  return withTimeout(run(binding, route, effectiveLaunchArguments), SAF02_PAGE_TIMEOUT_MS, "SAF-02 page");
}

async function run(binding, route, effectiveLaunchArguments) {
  assertBinding(binding, route);
  const observations = installObservers(globalThis);
  const viewerErrors = [];
  let phase = "bootstrap";
  const onError = (error) => viewerErrors.push({ phase, code: error?.code ?? null });
  const facadeUrl = new URL("node_modules/@forge3d/web/dist/index.js", route.applicationUrl).href;
  let facade;
  try {
    facade = await withTimeout(import(facadeUrl), OPERATION_TIMEOUT_MS, "ESM import");
    const wasmUrl = new URL(
      "node_modules/@forge3d/web/dist/forge3d_web_bg.wasm",
      route.applicationUrl,
    ).href;
    const wasm = await runWasmMatrix({ facadeUrl, route, observations });
    const terrain = await runTerrainMatrix({ facade, route, wasmUrl, onError, setPhase: (value) => { phase = value; } });
    const render = await runQuantitativeRender({ facade, wasmUrl, onError, setPhase: (value) => { phase = value; } });
    await twoAnimationFrames();
    const unexpectedViewerErrors = viewerErrors.filter(({ phase: errorPhase, code }) =>
      !EXPECTED_ERRORS.some((expected) => expected.phase === errorPhase && expected.code === code));
    if (unexpectedViewerErrors.length > 0) throw new Error("SAF-02 observed an unexpected viewer error");
    observations.assertCompleteAndClean();
    return {
      schemaVersion: 1,
      kind: "forge3d-saf02-conformance-v1",
      binding: {
        lane: binding.lane, assetId: binding.assetId, hostId: binding.hostId,
        runId: binding.runId, jobId: binding.jobId, commit: binding.commit,
        packageSha256: binding.packageSha256,
      },
      route: routeBinding(route, binding),
      environment: {
        secureContext: globalThis.isSecureContext === true,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        effectiveLaunchArguments: [...effectiveLaunchArguments],
      },
      wasm, terrain, render,
      observers: observations.result(viewerErrors),
      result: "PASS",
    };
  } finally {
    observations.restore();
  }
}

const EXPECTED_ERRORS = [
  { phase: "terrain-nonzero-200", code: "IO_ERROR" },
  { phase: "terrain-416", code: "IO_ERROR" },
  { phase: "terrain-cors-deny", code: "IO_ERROR" },
  { phase: "terrain-cors-wrong-origin", code: "IO_ERROR" },
];

async function runWasmMatrix({ facadeUrl, route, observations }) {
  const outcomes = {};
  for (const [name, wasmUrl, expected, alphaMode] of [
    ["correctMime", `${route.applicationUrl}forge3d_web_bg.wasm`, "PASS", "opaque"],
    ["allowedCors", `${route.assetUrl}cors/allow/forge3d_web_bg.wasm`, "PASS", "premultiplied"],
    ["badMime", `${route.applicationUrl}wrong-mime/forge3d_web_bg.wasm`, "WASM_LOAD_FAILED", "opaque"],
    ["deniedCors", `${route.assetUrl}cors/deny/forge3d_web_bg.wasm`, "WASM_LOAD_FAILED", "opaque"],
    ["wrongOriginCors", `${route.assetUrl}cors/wrong-origin/forge3d_web_bg.wasm`, "WASM_LOAD_FAILED", "opaque"],
  ]) {
    const isolated = await isolatedRuntimeOutcome({ facadeUrl, wasmUrl, expected, alphaMode });
    outcomes[name] = isolated.codes[0];
    observations.mergeFrame(isolated);
  }
  const retry = await sameRealmRetry({
    facadeUrl,
    wasmUrl: `${route.applicationUrl}saf02/retry/${crypto.randomUUID().replaceAll("-", "")}/forge3d_web_bg.wasm`,
  });
  if (retry.first !== "WASM_LOAD_FAILED" || retry.second !== "PASS" ||
      retry.sameRealm !== true || retry.identicalUrl !== true || retry.observersComplete !== true || retry.configureCalls.length < 1) {
    throw new Error("SAF-02 same-realm WASM retry failed");
  }
  observations.mergeFrame(retry);
  return { outcomes, retry };
}

async function isolatedRuntimeOutcome(input) {
  const result = await runInFreshRealm({ ...input, attempts: 1 });
  if (result.codes[0] !== input.expected || result.sameRealm !== true ||
      result.identicalUrl !== true || result.observersComplete !== true) {
    throw new Error(`${input.wasmUrl} returned ${result.codes[0]}, expected ${input.expected}`);
  }
  return result;
}

async function sameRealmRetry(input) {
  const result = await runInFreshRealm({ ...input, attempts: 2, alphaMode: "opaque" });
  return { id: result.id, first: result.codes[0], second: result.codes[1],
    sameRealm: result.sameRealm, identicalUrl: result.identicalUrl,
    observersComplete: result.observersComplete, observed: result.observed,
    configureCalls: result.configureCalls };
}

async function runInFreshRealm(input) {
  const id = `saf02-${crypto.randomUUID()}`;
  const frame = createObservedRealmFrame();
  frame.srcdoc = retryDocument({ ...input, id });
  document.body.append(frame);
  let listener;
  try {
    return await withTimeout(new Promise((resolve) => {
      listener = (event) => {
        if (event.source === frame.contentWindow && event.data?.id === id) {
          removeEventListener("message", listener);
          resolve(event.data);
        }
      };
      addEventListener("message", listener);
    }), OPERATION_TIMEOUT_MS * 2, "same-realm retry");
  } finally {
    if (listener) removeEventListener("message", listener);
    frame.remove();
  }
}

export function createObservedRealmFrame() {
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.inset = "0 auto auto 0";
  frame.style.width = "2px";
  frame.style.height = "2px";
  frame.style.border = "0";
  frame.style.opacity = "0.01";
  frame.style.pointerEvents = "none";
  frame.setAttribute("aria-hidden", "true");
  return frame;
}

function retryDocument(input) {
  const encoded = JSON.stringify(input).replaceAll("<", "\\u003c");
  return `<!doctype html><canvas id="c" width="2" height="2"></canvas><script type="module">
const input=${encoded}; const observed=[]; const configureCalls=[];
const onError=e=>observed.push({source:"window-error",message:String(e.message||"")});
const onReject=e=>observed.push({source:"unhandledrejection",message:String(e.reason||"")});
addEventListener("error",onError); addEventListener("unhandledrejection",onReject);
const originals={}; for(const level of ["debug","info","log","warn","error"]){ originals[level]=console[level]; console[level]=(...args)=>{ if(level==="error"||/validation|uncaptured/i.test(args.map(String).join(" "))) observed.push({source:"console-"+level,message:args.map(String).join(" ")}); originals[level].apply(console,args); }; }
const adapterProto=globalThis.GPUAdapter?.prototype, contextProto=globalThis.GPUCanvasContext?.prototype;
if(!adapterProto?.requestDevice||!contextProto?.configure) throw new Error("observer capability unavailable");
const requestDevice=adapterProto.requestDevice, configure=contextProto.configure;
adapterProto.requestDevice=async function(...args){ const device=await requestDevice.apply(this,args); device.addEventListener("uncapturederror",e=>observed.push({source:"device-uncaptured",message:String(e.error?.message||e.error||"")})); return device; };
contextProto.configure=function(descriptor){ configureCalls.push({format:String(descriptor.format),alphaMode:String(descriptor.alphaMode||"opaque")}); return configure.call(this,descriptor); };
let facade; const codes=[]; const realm=globalThis; const url=input.wasmUrl;
try { facade=await import(input.facadeUrl); for(let i=0;i<input.attempts;i++){ let runtime; try { runtime=await facade.Forge3DRuntime.create(document.querySelector("#c"),{wasmUrl:url,alphaMode:input.alphaMode}); runtime.dispose(); codes.push("PASS"); } catch(e){ runtime?.dispose(); codes.push(facade.Forge3DError.from(e).code); } }
await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
parent.postMessage({id:input.id,codes,sameRealm:realm===globalThis,identicalUrl:url===input.wasmUrl,observersComplete:true,observed,configureCalls},"*");
} finally { adapterProto.requestDevice=requestDevice; contextProto.configure=configure; for(const level of Object.keys(originals)) console[level]=originals[level]; removeEventListener("error",onError); removeEventListener("unhandledrejection",onReject); }
</script>`;
}

async function runTerrainMatrix({ facade, route, wasmUrl, onError, setPhase }) {
  const fullBytes = 512 * 512 * 4;
  const cases = [
    ["sameOriginFull", `${route.applicationUrl}terrain.bin`, {}, "PASS"],
    ["allowedCorsFull", `${route.assetUrl}cors/allow/terrain.bin`, {}, "PASS"],
    ["nonzero206", `${route.assetUrl}cors/allow/range-exact/terrain-range.bin`, { byteOffset: 4, byteLength: fullBytes }, "PASS"],
    ["zeroOffset200", `${route.assetUrl}cors/allow/range-ignored/terrain.bin`, { byteOffset: 0, byteLength: fullBytes }, "PASS"],
    ["nonzero200", `${route.assetUrl}cors/allow/range-ignored/terrain-range.bin`, { byteOffset: 4, byteLength: fullBytes }, "IO_ERROR"],
    ["range416", `${route.assetUrl}cors/allow/range-416/terrain-range.bin`, { byteOffset: 4, byteLength: fullBytes }, "IO_ERROR"],
    ["corsDeny", `${route.assetUrl}cors/deny/terrain.bin`, {}, "IO_ERROR"],
    ["corsWrongOrigin", `${route.assetUrl}cors/wrong-origin/terrain.bin`, {}, "IO_ERROR"],
  ];
  const phaseNames = { nonzero200: "terrain-nonzero-200", range416: "terrain-416", corsDeny: "terrain-cors-deny", corsWrongOrigin: "terrain-cors-wrong-origin" };
  const outcomes = {};
  for (const [name, source, range, expected] of cases) {
    setPhase(phaseNames[name] ?? `terrain-${name}`);
    const canvas = document.createElement("canvas");
    let viewer;
    try {
      viewer = await withTimeout(facade.Forge3DViewer.create(canvas, { resize: false, runtime: { wasmUrl }, onError }), OPERATION_TIMEOUT_MS, `${name} create`);
      await withTimeout(viewer.setTerrainFromSource({ width: 512, height: 512, source, ...range }), OPERATION_TIMEOUT_MS, name);
      if (expected !== "PASS") throw new Error(`${name} unexpectedly succeeded`);
      outcomes[name] = "PASS";
    } catch (error) {
      const code = facade.Forge3DError.from(error).code;
      if (code !== expected) throw new Error(`${name} returned ${code}, expected ${expected}`);
      outcomes[name] = code;
    } finally {
      viewer?.dispose();
    }
  }
  return { outcomes };
}

async function runQuantitativeRender({ facade, wasmUrl, onError, setPhase }) {
  setPhase("quantitative-render");
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  let viewer;
  try {
    viewer = await facade.Forge3DViewer.create(canvas, { resize: false, runtime: { wasmUrl, alphaMode: "opaque" }, onError });
    viewer.resize({ width: 77, height: 53, devicePixelRatio: 1 });
    const heights = new Float32Array(77 * 53);
    for (let y = 0; y < 53; y++) for (let x = 0; x < 77; x++) heights[y * 77 + x] = Math.sin(x / 8) * Math.cos(y / 7) * 8;
    viewer.setTerrain({ width: 77, height: 53, heights });
    await waitForFrame(viewer, "terrain frame");
    const beforeView = viewer.getView();
    const before = await pngPixels(await viewer.screenshot());
    const submittedFramesBeforeCamera = viewer.getDiagnostics().submittedFrames;
    viewer.setView({ ...beforeView, yawDegrees: beforeView.yawDegrees + 35, pitchDegrees: beforeView.pitchDegrees - 8 });
    await waitForFrame(viewer, "camera frame");
    const afterView = viewer.getView();
    const submittedFramesAfterCamera = viewer.getDiagnostics().submittedFrames;
    const after = await pngPixels(await viewer.screenshot());
    const metrics = comparePixels(before.pixels, after.pixels);
    if (before.width !== 77 || before.height !== 53 || after.width !== 77 || after.height !== 53 ||
        before.signature !== true || after.signature !== true || metrics.beforeLumaRange <= 20 || metrics.afterLumaRange <= 20 ||
        metrics.visiblePixels <= 3000 || metrics.comparedPixels !== 4081 || metrics.changedPixels <= 100 ||
        JSON.stringify(beforeView) === JSON.stringify(afterView)) throw new Error("SAF-02 quantitative render thresholds failed");
    return { width: 77, height: 53, beforeBytes: before.byteLength, afterBytes: after.byteLength,
      beforePngSignature: before.signature, afterPngSignature: after.signature, ...metrics,
      cameraChanged: true, submittedFramesBeforeCamera, submittedFramesAfterCamera, configure: null };
  } finally {
    viewer?.dispose(); canvas.remove();
  }
}

function installObservers(scope) {
  const observed = { windowErrors: [], rejections: [], console: [], deviceErrors: [], configure: [], frame: [] };
  const deviceProto = scope.GPUAdapter?.prototype;
  const contextProto = scope.GPUCanvasContext?.prototype;
  if (!deviceProto?.requestDevice || !contextProto?.configure ||
      Object.getOwnPropertyDescriptor(deviceProto, "requestDevice")?.writable === false ||
      Object.getOwnPropertyDescriptor(contextProto, "configure")?.writable === false) {
    throw new Error("SAF-02 observer capability is unavailable");
  }
  const onError = (event) => observed.windowErrors.push(String(event.message ?? ""));
  const onReject = (event) => observed.rejections.push(String(event.reason ?? ""));
  scope.addEventListener("error", onError); scope.addEventListener("unhandledrejection", onReject);
  const consoleOriginals = {};
  for (const level of ["debug", "info", "log", "warn", "error"]) {
    consoleOriginals[level] = console[level];
    console[level] = (...args) => { observed.console.push({ level, message: args.map(String).join(" ") }); consoleOriginals[level].apply(console, args); };
  }
  const requestDevice = deviceProto.requestDevice;
  const configure = contextProto.configure;
  deviceProto.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener("uncapturederror", (event) => observed.deviceErrors.push(String(event.error?.message ?? event.error ?? "")));
    return device;
  };
  contextProto.configure = function (descriptor) {
    observed.configure.push({ format: String(descriptor.format), alphaMode: String(descriptor.alphaMode ?? "opaque") });
    return configure.call(this, descriptor);
  };
  return {
    mergeFrame: ({ observed: frameObserved, configureCalls }) => {
      observed.frame.push(...frameObserved);
      observed.configure.push(...configureCalls);
    },
    assertCompleteAndClean() {
      if (observed.configure.length < 2 || !observed.configure.some((entry) => entry.alphaMode === "opaque") ||
          !observed.configure.some((entry) => entry.alphaMode === "premultiplied") ||
          observed.windowErrors.length || observed.rejections.length || observed.deviceErrors.length || observed.frame.length ||
          observed.console.some(({ level, message }) => level === "error" || /validation error|uncaptured/i.test(message))) {
        throw new Error("SAF-02 observer proof is incomplete or contains unexpected errors");
      }
    },
    result: (viewerErrors) => ({ installedBeforeInitialization: true, restored: true, windowErrors: observed.windowErrors,
      unhandledRejections: observed.rejections, consoleFindings: observed.console.filter(({ level, message }) => level === "error" || /validation/i.test(message)),
      deviceUncapturedErrors: observed.deviceErrors, configureCalls: observed.configure, viewerErrors }),
    restore() {
      deviceProto.requestDevice = requestDevice; contextProto.configure = configure;
      for (const level of Object.keys(consoleOriginals)) console[level] = consoleOriginals[level];
      scope.removeEventListener("error", onError); scope.removeEventListener("unhandledrejection", onReject);
    },
  };
}

async function pngPixels(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0); bitmap.close();
  return { signature, byteLength: bytes.byteLength, width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

export function comparePixels(before, after) {
  let beforeMin = 255, beforeMax = 0, afterMin = 255, afterMax = 0, visiblePixels = 0, changedPixels = 0;
  for (let offset = 0; offset < before.length; offset += 4) {
    const beforeLuma = (before[offset] + before[offset + 1] + before[offset + 2]) / 3;
    const afterLuma = (after[offset] + after[offset + 1] + after[offset + 2]) / 3;
    beforeMin = Math.min(beforeMin, beforeLuma); beforeMax = Math.max(beforeMax, beforeLuma);
    afterMin = Math.min(afterMin, afterLuma); afterMax = Math.max(afterMax, afterLuma); if (after[offset + 3] > 0) visiblePixels++;
    if (Math.max(Math.abs(before[offset] - after[offset]), Math.abs(before[offset + 1] - after[offset + 1]), Math.abs(before[offset + 2] - after[offset + 2])) >= 35) changedPixels++;
  }
  return { beforeLumaRange: beforeMax - beforeMin, afterLumaRange: afterMax - afterMin, visiblePixels, comparedPixels: before.length / 4, changedPixels };
}

async function waitForFrame(viewer, label) {
  const before = viewer.getDiagnostics().submittedFrames;
  for (let index = 0; index < 120; index++) { await new Promise(requestAnimationFrame); if (viewer.getDiagnostics().submittedFrames > before) return; }
  throw new Error(`${label} timed out`);
}

function routeBinding(route, binding) {
  const app = new URL(route.applicationUrl), asset = new URL(route.assetUrl);
  const expected = `/runs/${binding.runId}/${binding.jobId}/`;
  if (app.protocol !== "https:" || asset.protocol !== "https:" || app.origin === asset.origin || !app.pathname.startsWith(expected) || app.pathname !== asset.pathname || !/^\/runs\/[1-9][0-9]*\/[1-9][0-9]*\/[0-9a-f]{32}\/$/u.test(app.pathname)) throw new Error("SAF-02 route binding is invalid");
  return { applicationOrigin: app.origin, assetOrigin: asset.origin, basePath: app.pathname, nonce: app.pathname.split("/").at(-2) };
}

function assertBinding(binding, route) {
  if (binding?.lane !== "safari-macos-m2" || binding.assetId !== "FW-MAC-M2-01" || binding.hostId !== "FW-MAC-M2-01" ||
      !Number.isInteger(binding.runId) || !Number.isInteger(binding.jobId) || !/^[0-9a-f]{40}$/u.test(binding.commit ?? "") ||
      !/^[0-9a-f]{64}$/u.test(binding.packageSha256 ?? "")) throw new Error("SAF-02 execution binding is invalid");
  routeBinding(route, binding);
  if (globalThis.isSecureContext !== true) throw new Error("SAF-02 requires a trusted secure context");
}

async function twoAnimationFrames() { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }

export function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
