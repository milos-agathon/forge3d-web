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
    adapter.deviceCreated !== true ||
    adapter.surfaceCreated !== true ||
    adapter.surfacePresented !== true ||
    adapter.lumaChanged !== true
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

async function verifyBrowserRoute(route, expectedPackageSha256) {
  if (
    route?.applicationUrl !== window.location.href &&
    route?.applicationUrl !== window.location.href.replace(/index\.html$/u, "")
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
  const packageResponse = await fetch(`${application}package.sha256`, {
    cache: "no-store",
  });
  const wasmResponse = await fetch(`${application}forge3d_web_bg.wasm`, {
    cache: "no-store",
  });
  const allowedRange = await fetch(`${asset}cors/allow/terrain.bin`, {
    headers: { Range: "bytes=1-3" },
    cache: "no-store",
  });
  const allowedWasm = await fetch(
    `${asset}cors/allow/forge3d_web_bg.wasm`,
    { cache: "no-store" },
  );
  const packageHash = (await packageResponse.text()).trim().split(/\s+/u)[0];
  if (
    packageResponse.status !== 200 ||
    packageHash !== expectedPackageSha256 ||
    wasmResponse.headers.get("content-type") !== "application/wasm" ||
    allowedRange.status !== 206 ||
    allowedRange.headers.get("content-range")?.startsWith("bytes 1-3/") !==
      true ||
    allowedWasm.headers.get("content-type") !== "application/wasm"
  ) {
    throw new Error("browser route MIME, package, range, or CORS proof failed");
  }
  await WebAssembly.compileStreaming(Promise.resolve(allowedWasm));
  await expectCorsFailure(`${asset}cors/deny/terrain.bin`);
  await expectCorsFailure(`${asset}cors/wrong-origin/terrain.bin`);
  await expectCorsFailure(`${asset}cors/deny/forge3d_web_bg.wasm`);
  await expectCorsFailure(`${asset}cors/wrong-origin/forge3d_web_bg.wasm`);
  let wrongMimeRejected = false;
  try {
    await WebAssembly.compileStreaming(
      fetch(`${application}wrong-mime/forge3d_web_bg.wasm`, {
        cache: "no-store",
      }),
    );
  } catch {
    wrongMimeRejected = true;
  }
  if (!wrongMimeRejected) {
    throw new Error("browser accepted the intentional wrong WASM MIME");
  }
  return {
    trustedHttps: true,
    packageSha256Matched: true,
    wasmMimePassed: true,
    corsAllowPassed: true,
    corsDenyPassed: true,
    rangePassed: true,
    wrongMimeRejected: true,
  };
}

async function expectCorsFailure(url) {
  try {
    await fetch(url, { cache: "no-store" });
  } catch {
    return;
  }
  throw new Error(`browser did not enforce CORS failure for ${url}`);
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
