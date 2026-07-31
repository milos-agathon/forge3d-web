import { captureAdapterAttestation } from "./adapter-attestation.js";

export async function runHardwarePage({
  binding,
  route,
  effectiveLaunchArguments = [],
  supportAssertions = true,
  mediaChallenge = null,
}) {
  const fixture = window.__forge3dInteractiveViewer;
  const canvas = fixture?.canvas ?? document.querySelector("#viewer");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("hardware fixture canvas is unavailable");
  }
  const watermark = installWatermark(mediaChallenge);
  const routeReadiness = await verifyBrowserRoute(route, binding.packageSha256);
  const adapter = await captureAdapterAttestation(
    canvas,
    binding,
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
  if (!supportAssertions) {
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

  const viewer = await fixture.create();
  const screenshot = await viewer.screenshot();
  const diagnostics = viewer.getDiagnostics();
  const assertions = {
    supportAssertionsExecuted: true,
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
  return { adapter, assertions, routeReadiness, watermark };
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

function installWatermark(mediaChallenge) {
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
  watermark.textContent = `SESSION_CHALLENGE_VISIBLE ${mediaChallenge}`;
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
  });
  shell.append(watermark);
  return {
    mediaChallenge,
    nonDismissable: true,
    overlayTarget: "viewer-shell-not-canvas",
    visible: watermark.getClientRects().length > 0,
  };
}
