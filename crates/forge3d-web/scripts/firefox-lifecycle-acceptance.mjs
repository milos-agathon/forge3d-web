import { FFX04_LANES, isFfx04Lane } from "./ffx04-lanes.mjs";
import { validateFfx04LifecycleProof } from "./ffx04-lifecycle-proof-validator.mjs";

export async function runFirefoxLifecycleAcceptance({
  session,
  lane,
  assetId,
  platform,
  binding,
  route,
  browser,
  driver,
  launchObservation,
}) {
  assertInputs({ session, lane, assetId, platform, binding, route, browser, driver, launchObservation });
  const base = new URL(route.applicationUrl);
  const viewerUrl = new URL("lifecycle-viewer.html", base).href;
  const awayUrl = new URL("lifecycle-away.html", base).href;
  const cycles = [];
  let primaryError = null;
  let viewerLoaded = false;
  let disposed = null;
  try {
    await session.navigate(viewerUrl);
    viewerLoaded = true;
    let expectedToken = null;
    let expectedGeneration = null;
    let expectedListeners = null;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const prepared = await session.runBfcacheLifecycleAction(
        "prepareViewerBfcacheCycle",
        [cycle],
      );
      expectedToken ??= prepared.documentToken;
      expectedGeneration ??= prepared.diagnostics.generation;
      expectedListeners ??= prepared.diagnostics.ownedListeners;
      if (
        prepared.documentToken !== expectedToken ||
        prepared.diagnostics.generation !== expectedGeneration ||
        prepared.diagnostics.ownedListeners !== expectedListeners
      ) {
        throw new Error(`FFX04_BASELINE_IDENTITY_CHANGED cycle=${cycle}`);
      }
      await session.navigate(awayUrl);
      if (await session.currentUrl() !== awayUrl) {
        throw new Error(`FFX04_AWAY_ROUTE_MISMATCH cycle=${cycle}`);
      }
      await session.historyBack();
      if (await session.currentUrl() !== viewerUrl) {
        throw new Error(`FFX04_VIEWER_ROUTE_MISMATCH cycle=${cycle}`);
      }
      const restored = await session.runBfcacheLifecycleAction(
        "observeViewerBfcacheRestore",
        [cycle],
      );
      if (
        restored.restored.documentToken !== expectedToken ||
        restored.restored.diagnostics.generation !== expectedGeneration ||
        restored.restored.diagnostics.ownedListeners !== expectedListeners
      ) {
        throw new Error(`FFX04_RESTORE_IDENTITY_CHANGED cycle=${cycle}`);
      }
      cycles.push({ prepared, ...restored });
    }
    const input = await session.runBfcacheLifecycleAction("exerciseViewerAfterBfcache");
    disposed = await session.runBfcacheLifecycleAction("disposeViewerBfcacheLifecycle");
    const proof = {
      schemaVersion: 1,
      task: "FFX-04",
      binding: {
        lane,
        runId: binding.runId,
        jobId: binding.jobId,
        assetId,
        platform,
        commit: binding.commit,
        packageSha256: binding.packageSha256,
      },
      route: { viewerUrl, awayUrl, basePath: base.pathname },
      browser,
      driver,
      launchObservation,
      sourceContract: "stock-firefox-geckodriver-bfcache-v1",
      trustedPersistedLifecycle: true,
      cycleCount: 3,
      cycles,
      input,
      disposed,
      result: "PASS",
    };
    validateFfx04LifecycleProof(proof, {
      lane, runId: binding.runId, jobId: binding.jobId, assetId, platform,
      commit: binding.commit, packageSha256: binding.packageSha256,
      browser, driver, applicationUrl: route.applicationUrl,
    });
    return proof;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (viewerLoaded && disposed === null) {
      await session.runBfcacheLifecycleAction("disposeViewerBfcacheLifecycle").catch(() => undefined);
    }
    try {
      await session.navigate(route.applicationUrl);
    } catch (cleanupError) {
      if (primaryError === null) throw cleanupError;
    }
  }
}

function assertInputs(value) {
  if (!isFfx04Lane(value.lane)) throw new Error("FFX04_LANE_INVALID");
  const expected = FFX04_LANES[value.lane];
  if (value.assetId !== expected.assetId || value.platform !== expected.platform) {
    throw new Error("FFX04_LANE_ASSET_PLATFORM_MISMATCH");
  }
  if (
    value.binding?.lane !== value.lane ||
    value.binding?.assetId !== value.assetId ||
    !Number.isSafeInteger(value.binding?.runId) || value.binding.runId < 1 ||
    !Number.isSafeInteger(value.binding?.jobId) || value.binding.jobId < 1 ||
    !/^[0-9a-f]{40}$/u.test(value.binding?.commit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(value.binding?.packageSha256 ?? "")
  ) throw new Error("FFX04_BINDING_INVALID");
  if (
    value.browser?.name !== "firefox" || value.browser?.channel !== "release" ||
    typeof value.browser?.version !== "string" || value.browser.version === "unknown" ||
    value.driver?.name !== "selenium-firefox" ||
    typeof value.driver?.version !== "string" || !value.driver.version ||
    value.launchObservation?.observed !== true ||
    value.launchObservation?.source !== `${value.platform}-live-browser-process` ||
    !Number.isInteger(value.launchObservation?.browserProcessId) ||
    value.launchObservation.browserProcessId < 1
  ) throw new Error("FFX04_PROVENANCE_INVALID");
  const application = new URL(value.route?.applicationUrl ?? "invalid:");
  const routeMatch = /^\/runs\/([1-9][0-9]*)\/([1-9][0-9]*)\/([0-9a-f]{32})\/$/u.exec(application.pathname);
  if (
    application.protocol !== "https:" || application.username || application.password ||
    application.search || application.hash || !routeMatch ||
    Number(routeMatch[1]) !== value.binding.runId || Number(routeMatch[2]) !== value.binding.jobId
  ) throw new Error("FFX04_ROUTE_INVALID");
  if (!value.session?.navigate || !value.session?.historyBack || !value.session?.runBfcacheLifecycleAction) {
    throw new Error("FFX04_WEBDRIVER_INTERFACE_INVALID");
  }
}
