import { captureAdapterAttestation } from "./adapter-attestation.js";
import { runViewerBenchmarkInBrowser } from "./viewer-benchmark-browser.js";
import { isChr03Lane } from "./chr03-lanes.js";

export async function runHardwarePage({
  lane,
  binding,
  route,
  effectiveLaunchArguments = [],
  supportAssertions = true,
  mediaChallenge = null,
  chr03 = null,
  sessionContext = null,
}) {
  const fixture = window.__forge3dInteractiveViewer;
  const canvas = fixture?.canvas ?? document.querySelector("#viewer");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("hardware fixture canvas is unavailable");
  }
  const productManual = isProductManualLane(lane);
  const watermark = mediaChallenge !== null
    ? installWatermark(mediaChallenge, sessionContext)
    : null;
  const routeReadiness = await verifyBrowserRoute(route, binding.packageSha256);
  const adapter = await captureAdapterAttestation(
    canvas,
    adapterBinding(binding),
    effectiveLaunchArguments,
  );
  if (
    adapter.adapterInfoAvailable !== true ||
    adapter.isFallbackAdapter !== false ||
    adapter.secureContext !== true ||
    adapter.deviceCreated !== true ||
    adapter.surfaceCreated !== true ||
    adapter.surfacePresented !== true ||
    !hasMeasuredLumaPresentation(adapter)
  ) {
    throw new Error("ATTESTATION_UNAVAILABLE: hardware adapter proof failed");
  }
  if (!supportAssertions && !productManual) {
    return {
      adapter,
      assertions: {
        supportAssertionsExecuted: false,
        passed: true,
      },
      routeReadiness,
      watermark,
    };
  }

  const assertions = await runInitialViewerAssertions({
    fixture,
    supportAssertions,
    retainViewer: productManual,
    onError: window.__forge3dChr03OnError,
  });
  const chr03Proof = isChr03Lane(lane)
    ? await runChr03HardwareProof({ binding, route, chr03 })
    : null;
  return { adapter, assertions, routeReadiness, watermark, chr03Proof };
}

export async function runInitialViewerAssertions({
  fixture,
  supportAssertions,
  retainViewer,
  onError,
}) {
  let viewer;
  try {
    viewer = await fixture.create({ onError });
    const screenshot = await viewer.screenshot();
    const diagnostics = viewer.getDiagnostics();
    const assertions = {
      supportAssertionsExecuted: supportAssertions,
      screenshotPng:
        screenshot.type === "image/png" && Number(screenshot.size) > 0,
      submittedFrame: diagnostics.submittedFrames > 0,
      runtimeReady: viewer.status === "ready",
    };
    assertions.passed = Object.entries(assertions)
      .filter(([name]) => name !== "supportAssertionsExecuted")
      .every(([, passed]) => passed === true);
    if (!assertions.passed) {
      throw new Error("browser-neutral installed-package assertions failed");
    }
    if (retainViewer) return assertions;
    viewer.dispose();
    const disposed = viewer.getDiagnostics();
    if (disposed.ownedListeners !== 0 || disposed.activeObservers !== 0 ||
        disposed.activePointers !== 0 || disposed.activeRuntimes !== 0 ||
        disposed.pendingAnimationFrame !== false ||
        disposed.ownedAnimationFrameCount !== 0) {
      throw new Error("initial hardware viewer did not release its resources");
    }
    return assertions;
  } catch (error) {
    viewer?.dispose();
    if (!viewer) showUnsupportedState(error);
    throw error;
  }
}

export function adapterBinding(binding) {
  return {
    runId: binding.runId,
    jobId: binding.jobId,
    assetId: binding.assetId,
    commit: binding.commit,
    packageSha256: binding.packageSha256,
  };
}

async function runChr03HardwareProof({ binding, route, chr03 }) {
  if (!chr03?.driver || !chr03.visibility || !chr03.systemInfo || !Array.isArray(chr03.observedErrors)) {
    throw new Error("required Chrome lane is missing native-driver CHR-03 observations");
  }
  const fixture = window.__forge3dInteractiveViewer;
  const terrainUrl = new URL("cors/allow/terrain.bin", route.assetUrl).href;
  if (new URL(terrainUrl).protocol !== "https:" ||
      new URL(terrainUrl).origin === new URL(route.applicationUrl).origin) {
    throw new Error("CHR-03 cross-origin 512x512 terrain source is invalid");
  }
  const terrainViewer = await fixture.create({ resize: false, controls: { keyboard: true }, onError: window.__forge3dChr03OnError });
  terrainViewer.resize({ width: 320, height: 320, devicePixelRatio: 2 });
  const beforeTerrain = terrainViewer.getDiagnostics().submittedFrames;
  const progressEvents = [];
  await terrainViewer.setTerrainFromSource({
    width: 512,
    height: 512,
    source: terrainUrl,
    onProgress: (event) => progressEvents.push({ loaded: event.loaded, total: event.total, done: event.done }),
  });
  await waitForSubmittedFrame(terrainViewer, beforeTerrain, "terrain source");
  const terrainSubmitted = terrainViewer.getDiagnostics().submittedFrames > beforeTerrain;
  const screenshotBlob = await terrainViewer.screenshot();
  const screenshotBytes = await screenshotBlob.arrayBuffer();
  const screenshot = await readPngEvidence(screenshotBlob, screenshotBytes);
  terrainViewer.dispose();

  const benchmarkBase = new URL("tests/browser/benchmark/", route.applicationUrl);
  const benchmark = await runViewerBenchmarkInBrowser({
    includeSchedulingEvidence: true,
    environment: {
      browserZoom: 1,
      thermalState: "unavailable",
      thermalSignalProvenance: "browser API unavailable",
      lowPowerMode: "unavailable",
      lowPowerSignalProvenance: "browser API unavailable",
    },
    assetUrls: {
      manifest: new URL("benchmark-manifest-v1.json", benchmarkBase).href,
      terrain: new URL("benchmark-terrain-v1.f32le", benchmarkBase).href,
      trace: new URL("benchmark-trace-v1.json", benchmarkBase).href,
    },
  });
  const lifecycleCycles = await runRenderedLifecycleCycles({ fixture, binding, onError: window.__forge3dChr03OnError });
  const visibilityCycles = chr03.visibility.cycles ?? [];
  const submittedEveryCycle = visibilityCycles.length === 30 &&
    visibilityCycles.every((cycle) => cycle.visibleFrame === "submitted");
  const driver = chr03.driver;
  return {
    schemaVersion: 1,
    kind: "forge3d-chr03-chrome-hardware-proof-v1",
    binding: {
      lane: binding.lane,
      assetId: binding.assetId,
      commit: binding.commit,
      packageSha256: binding.packageSha256,
    },
    behaviors: {
      orbit: driver.orbitChanged === true,
      pan: driver.panChanged === true,
      wheelZoom: driver.wheelChanged === true,
      pointerCapture: driver.pointerCapture?.captured === true && driver.pointerCapture?.released === true && driver.pointerCapture?.outsideMoveChanged === true && driver.pointerCapture?.activePointersAfter === 0,
      keyboard: Object.values(driver.keyboard ?? {}).length === 5 && Object.values(driver.keyboard).every((event) => event.changed === true),
      autoResize: Object.values(driver.autoResize ?? {}).length === 3 && Object.values(driver.autoResize).every(Boolean),
      visibilityResume: chr03.visibility.actualDocumentVisibilityTransitions === true && submittedEveryCycle,
      terrainSource: terrainSubmitted,
      screenshot: screenshot.mimeType === "image/png" && screenshot.byteLength > 0,
      disposal: lifecycleCycles.every(({ afterDispose }) => resourcesReleased(afterDispose)),
    },
    driver,
    visibility: {
      source: chr03.visibility.visibilityStateSource,
      cycleCount: chr03.visibility.cycleCount,
      hiddenObserved: visibilityCycles.every((cycle) => cycle.hiddenPendingFrameCancelled === true),
      visibleObserved: chr03.visibility.final?.visibilityState === "visible",
      submittedEveryCycle,
    },
    terrainSource: { api: "setTerrainFromSource", url: terrainUrl, crossOrigin: true, width: 512, height: 512,
      byteLength: progressEvents.at(-1)?.total ?? 0, progressEvents, completed: progressEvents.at(-1)?.done === true,
      submittedFrame: terrainSubmitted },
    screenshot,
    lifecycleCycles,
    errors: [...chr03.observedErrors],
    benchmark,
    systemInfo: chr03.systemInfo,
  };
}

async function waitForSubmittedFrame(viewer, before, label, nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await nextFrame();
    if (viewer.getDiagnostics().submittedFrames > before) return;
  }
  throw new Error(`${label} did not submit a frame`);
}

function resourcesReleased(diagnostics) {
  return diagnostics.ownedListeners === 0 && diagnostics.activeObservers === 0 &&
    diagnostics.activePointers === 0 && diagnostics.activeRuntimes === 0 &&
    diagnostics.pendingAnimationFrame === false && diagnostics.ownedAnimationFrameCount === 0;
}

function resourceDiagnostics(diagnostics) {
  return {
    ownedListeners: diagnostics.ownedListeners,
    activeObservers: diagnostics.activeObservers,
    activePointers: diagnostics.activePointers,
    activeRuntimes: diagnostics.activeRuntimes,
    pendingAnimationFrame: diagnostics.pendingAnimationFrame,
    ownedAnimationFrameCount: diagnostics.ownedAnimationFrameCount,
  };
}

export async function runRenderedLifecycleCycles({
  fixture,
  binding,
  onError,
  nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve)),
  createIdentity = (index) => `${binding.runId}:${binding.jobId}:${index + 1}:${crypto.randomUUID()}`,
}) {
  const cycles = [];
  for (let index = 0; index < 50; index += 1) {
    const viewer = await fixture.create({ resize: false, controls: { keyboard: true }, onError });
    let live;
    try {
      await waitForSubmittedFrame(viewer, 0, `lifecycle cycle ${index + 1}`, nextFrame);
      live = viewer.getDiagnostics();
      if (live.activeRuntimes !== 1 || live.ownedListeners < 1 || live.submittedFrames < 1) {
        throw new Error(`lifecycle cycle ${index + 1} did not own a live rendered runtime`);
      }
    } finally {
      viewer.dispose();
    }
    cycles.push({
      cycle: index + 1,
      runtimeIdentity: createIdentity(index),
      submittedFrames: live.submittedFrames,
      afterDispose: resourceDiagnostics(viewer.getDiagnostics()),
    });
  }
  return cycles;
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function readPngEvidence(blob, bytes) {
  const view = new DataView(bytes);
  const signature = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  if (blob.type !== "image/png" || signature.join(",") !== "137,80,78,71,13,10,26,10" || bytes.byteLength < 24) {
    throw new Error("viewer screenshot is not a complete PNG");
  }
  return { mimeType: blob.type, byteLength: bytes.byteLength, sha256: await sha256(bytes), width: view.getUint32(16), height: view.getUint32(20) };
}

export function isProductManualLane(lane) {
  return lane === "manual-safari-trackpad" ||
    lane === "manual-mobile-multitouch";
}

function hasMeasuredLumaPresentation(adapter) {
  const samples = adapter?.presentedFrameLumaSamples;
  if (
    adapter?.lumaChanged !== true ||
    !Array.isArray(samples) ||
    samples.length !== 2 ||
    samples.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    ) ||
    !Number.isFinite(adapter.presentedFrameLumaDelta)
  ) {
    return false;
  }
  const measuredDelta = Math.abs(samples[1] - samples[0]);
  return (
    measuredDelta >= 0.25 &&
    Math.abs(adapter.presentedFrameLumaDelta - measuredDelta) <= 1e-9
  );
}

export async function verifyBrowserRoute(
  route,
  expectedPackageSha256,
  dependencies = {},
) {
  const pageUrl = dependencies.pageUrl ?? window.location.href;
  const secureContext =
    dependencies.secureContext ?? globalThis.isSecureContext;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const loaderProbe =
    dependencies.loaderProbe ?? probeInstalledPackageLoader;
  if (secureContext !== true) {
    throw new Error("browser route is not a secure context");
  }
  if (
    route?.applicationUrl !== pageUrl &&
    route?.applicationUrl !== pageUrl.replace(/index\.html$/u, "")
  ) {
    throw new Error("browser route does not match the navigated HTTPS page");
  }
  if (
    !route.applicationUrl.startsWith("https://") ||
    !route.assetUrl.startsWith("https://") ||
    new URL(route.applicationUrl).origin === new URL(route.assetUrl).origin
  ) {
    throw new Error("browser route must use distinct trusted HTTPS origins");
  }
  const application = route.applicationUrl;
  const asset = route.assetUrl;
  const packageResponse = await fetchImpl(`${application}package.sha256`, {
    cache: "no-store",
  });
  const wasmResponse = await fetchImpl(`${application}forge3d_web_bg.wasm`, {
    cache: "no-store",
  });
  const allowedRange = await fetchImpl(`${asset}cors/allow/terrain.bin`, {
    headers: { Range: "bytes=1-3" },
    cache: "no-store",
  });
  const allowedWasm = await fetchImpl(
    `${asset}cors/allow/forge3d_web_bg.wasm`,
    { cache: "no-store" },
  );
  const packageHash = (await packageResponse.text()).trim().split(/\s+/u)[0];
  if (
    packageResponse.status !== 200 ||
    packageHash !== expectedPackageSha256 ||
    wasmResponse.status !== 200 ||
    wasmResponse.headers.get("content-type") !== "application/wasm" ||
    allowedRange.status !== 206 ||
    allowedRange.headers.get("content-range")?.startsWith("bytes 1-3/") !==
      true ||
    allowedWasm.status !== 200 ||
    allowedWasm.headers.get("content-type") !== "application/wasm"
  ) {
    throw new Error("browser route MIME, package, range, or CORS proof failed");
  }
  await expectCorsFailure(
    `${asset}cors/deny/terrain.bin`,
    fetchImpl,
  );
  await expectCorsFailure(
    `${asset}cors/wrong-origin/terrain.bin`,
    fetchImpl,
  );

  const facadeUrl = new URL(
    "node_modules/@forge3d/web/dist/index.js",
    application,
  ).href;
  const allowedLoader = await loaderProbe({
    facadeUrl,
    wasmUrl: `${asset}cors/allow/forge3d_web_bg.wasm`,
  });
  if (
    allowedLoader?.ok !== true ||
    allowedLoader.runtimeCreated !== true ||
    allowedLoader.secureContext !== true
  ) {
    throw new Error(
      "installed Forge3D loader did not accept the exact allowed dual-origin WASM route",
    );
  }
  const wrongMimeLoader = await loaderProbe({
    facadeUrl,
    wasmUrl: `${application}wrong-mime/forge3d_web_bg.wasm`,
  });
  const deniedLoader = await loaderProbe({
    facadeUrl,
    wasmUrl: `${asset}cors/deny/forge3d_web_bg.wasm`,
  });
  const wrongOriginLoader = await loaderProbe({
    facadeUrl,
    wasmUrl: `${asset}cors/wrong-origin/forge3d_web_bg.wasm`,
  });
  assertNormalizedWasmLoadFailure(wrongMimeLoader, "wrong-MIME");
  assertNormalizedWasmLoadFailure(deniedLoader, "denied-origin");
  assertNormalizedWasmLoadFailure(wrongOriginLoader, "wrong-origin");
  return {
    secureContext: true,
    trustedHttps: true,
    applicationCertificateTrusted: true,
    assetCertificateTrusted: true,
    packageSha256Matched: true,
    wasmMimePassed: true,
    corsAllowPassed: true,
    corsDenyPassed: true,
    rangePassed: true,
    wrongMimeRejected: true,
    publicLoaderAllowedWasmPassed: true,
    wrongMimeErrorCode: wrongMimeLoader.code,
    corsDenyWasmErrorCode: deniedLoader.code,
    corsWrongOriginWasmErrorCode: wrongOriginLoader.code,
  };
}

async function expectCorsFailure(url, fetchImpl) {
  try {
    await fetchImpl(url, { cache: "no-store" });
  } catch {
    return;
  }
  throw new Error(`browser did not enforce CORS failure for ${url}`);
}

function assertNormalizedWasmLoadFailure(result, label) {
  if (
    result?.ok !== false ||
    result.secureContext !== true ||
    result.normalizedForge3DError !== true ||
    result.code !== "WASM_LOAD_FAILED"
  ) {
    throw new Error(
      `${label} WASM load did not return normalized Forge3DError WASM_LOAD_FAILED`,
    );
  }
}

let loaderProbeSequence = 0;

async function probeInstalledPackageLoader({ facadeUrl, wasmUrl }) {
  if (typeof document === "undefined") {
    throw new Error("installed package loader probe requires a browser document");
  }
  loaderProbeSequence += 1;
  const probeId = `forge3d-loader-probe-${loaderProbeSequence}`;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "2px",
    height: "2px",
    border: "0",
  });
  frame.srcdoc = installedLoaderProbeDocument({
    probeId,
    facadeUrl,
    wasmUrl,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`installed package loader probe timed out for ${wasmUrl}`));
    }, 15_000);
    const onMessage = (event) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.probeId !== probeId
      ) {
        return;
      }
      cleanup();
      resolve(event.data);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      frame.remove();
    };
    window.addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

function installedLoaderProbeDocument({ probeId, facadeUrl, wasmUrl }) {
  const input = JSON.stringify({ probeId, facadeUrl, wasmUrl }).replaceAll(
    "<",
    "\\u003c",
  );
  return `<!doctype html>
<meta charset="utf-8">
<canvas id="probe" width="2" height="2"></canvas>
<script type="module">
const input = ${input};
let facade = null;
let runtime = null;
try {
  facade = await import(input.facadeUrl);
  runtime = await facade.Forge3DRuntime.create(
    document.querySelector("#probe"),
    { wasmUrl: input.wasmUrl },
  );
  runtime.dispose();
  runtime = null;
  parent.postMessage({
    probeId: input.probeId,
    ok: true,
    runtimeCreated: true,
    secureContext: globalThis.isSecureContext === true,
  }, "*");
} catch (error) {
  runtime?.dispose();
  const normalized = facade?.Forge3DError?.from
    ? facade.Forge3DError.from(error)
    : error;
  parent.postMessage({
    probeId: input.probeId,
    ok: false,
    runtimeCreated: false,
    secureContext: globalThis.isSecureContext === true,
    normalizedForge3DError:
      Boolean(facade?.Forge3DError) &&
      normalized instanceof facade.Forge3DError,
    code: typeof normalized?.code === "string" ? normalized.code : null,
    name: typeof normalized?.name === "string" ? normalized.name : null,
  }, "*");
}
</script>`;
}

function installWatermark(mediaChallenge, sessionContext) {
  if (mediaChallenge === null) return null;
  if (!/^[0-9a-f]{32}$/u.test(mediaChallenge)) {
    throw new Error("manual session media challenge is malformed");
  }
  const shell =
    document.querySelector("#viewer-shell") ??
    document.querySelector("main") ??
    document.body;
  const watermark = document.createElement("div");
  watermark.id = "forge3d-session-watermark";
  if (!sessionContext || typeof sessionContext !== "object") {
    throw new Error("manual session context is missing");
  }
  const lines = [
    `SESSION_CHALLENGE_VISIBLE ${mediaChallenge}`,
    `tester=${sessionContext.expectedTester}`,
    `asset=${sessionContext.assetId} host=${sessionContext.hostId}`,
    `package=${sessionContext.packageSha256}`,
    `browser=${sessionContext.browser?.name}/${sessionContext.browser?.channel}/${sessionContext.browser?.version}`,
    `os=${sessionContext.system?.os}/${sessionContext.system?.build}`,
    `utc=${new Date().toISOString()}`,
  ];
  if (sessionContext.trackpad) {
    lines.push(`trackpad=${sessionContext.trackpad.model}/${sessionContext.trackpad.firmware}/${sessionContext.trackpad.transport}`);
  }
  if (lines.some((line) => /undefined|null/u.test(line))) {
    throw new Error("manual session context is incomplete");
  }
  watermark.textContent = lines.join("\n");
  Object.assign(watermark.style, {
    position: "fixed",
    inset: "12px 12px auto auto",
    zIndex: "2147483647",
    padding: "8px 12px",
    color: "#fff",
    background: "rgba(120, 0, 0, 0.92)",
    border: "2px solid #fff",
    font: "700 16px/1.25 monospace",
    pointerEvents: "none",
    userSelect: "none",
    maxWidth: "calc(100vw - 24px)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  });
  shell.append(watermark);
  return {
    mediaChallenge,
    sessionContext,
    nonDismissable: true,
    overlayTarget: "viewer-shell-not-canvas",
    visible: watermark.getClientRects().length > 0,
  };
}

function showUnsupportedState(error) {
  const alert = document.createElement("div");
  alert.setAttribute("role", "alert");
  alert.textContent = `Viewer unavailable: ${error?.code ?? "INTERNAL"}`;
  document.body.append(alert);
}
