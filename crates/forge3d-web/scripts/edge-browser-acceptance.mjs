export async function runEdgeBrowserAcceptance({ browser, page, fixtureUrl }) {
  if (!browser || !page || typeof fixtureUrl !== "string" || fixtureUrl.length === 0) {
    throw new Error("Edge browser acceptance requires the live browser, page, and installed fixture URL");
  }
  const touch = await exerciseSyntheticTouch(page);
  const missingApi = await runUnsupportedCase({ browser, fixtureUrl, setup: installMissingGpu, expectedCode: "WEBGPU_UNAVAILABLE" });
  const nullAdapter = await runUnsupportedCase({ browser, fixtureUrl, setup: installNullAdapter, expectedCode: "WEBGPU_ADAPTER_UNAVAILABLE", recover: true });
  const unrelated = await runUnrelatedErrorCase({ browser, fixtureUrl });
  return {
    kind: "forge3d-chr04-edge-browser-diagnostics-v1",
    synthetic: true,
    physicalPolicyProof: false,
    touch,
    unsupported: { missingApi, nullAdapter, unrelated },
  };
}

export async function withIsolatedBrowserContext({ browser, fixtureUrl, setup, inspect, stage = () => undefined }) {
  const context = await browser.newContext();
  try {
    stage("init");
    if (setup) await context.addInitScript(setup);
    stage("page");
    const page = await context.newPage();
    stage("navigation");
    await page.goto(fixtureUrl);
    stage("assertion");
    return await inspect(page);
  } finally {
    await context.close();
  }
}

async function exerciseSyntheticTouch(page) {
  return page.evaluate(async () => {
    const fixture = window.__forge3dInteractiveViewer;
    const viewer = await fixture.create({ controls: true, resize: false });
    const before = viewer.getView();
    const event = (type, x, y) => new PointerEvent(type, {
      bubbles: true, pointerId: 73, pointerType: "touch", clientX: x, clientY: y, isPrimary: true,
    });
    fixture.canvas.dispatchEvent(event("pointerdown", 120, 120));
    fixture.canvas.dispatchEvent(event("pointermove", 150, 95));
    fixture.canvas.dispatchEvent(event("pointerup", 150, 95));
    const after = viewer.getView();
    const diagnostics = viewer.getDiagnostics();
    viewer.dispose();
    return {
      injectedAtBrowserBoundary: true,
      pointerType: "touch",
      pointerId: 73,
      viewChanged: JSON.stringify(before) !== JSON.stringify(after),
      activePointersAfter: diagnostics.activePointers,
      disposed: viewer.status === "disposed" && viewer.getDiagnostics().activeRuntimes === 0,
    };
  });
}

async function runUnsupportedCase({ browser, fixtureUrl, setup, expectedCode, recover = false }) {
  return withIsolatedBrowserContext({
    browser, fixtureUrl, setup,
    inspect: async (page) => {
      const result = await page.evaluate(async () => {
        let thrownCode = null;
        try { await window.__forge3dInteractiveViewer.create(); } catch (error) { thrownCode = error?.code ?? null; }
        const unsupported = document.querySelector("#unsupported");
        const text = unsupported?.textContent ?? "";
        return {
          thrownCode,
          publicCode: window.__forge3dInteractiveViewer.errorCode,
          status: document.querySelector("#status")?.value,
          unsupportedVisible: unsupported?.hidden === false,
          adapterIntercepted: globalThis.__forge3dRequestAdapterIntercepted ?? null,
          hasBypassAdvice: /unsafe-webgpu|ignore-gpu-blocklist|ignore-certificate-errors|browser flag|edge:\/\//iu.test(text),
          bypassLinks: unsupported?.querySelectorAll("a").length ?? 0,
        };
      });
      if (result.thrownCode !== expectedCode || result.publicCode !== expectedCode || result.status !== "unsupported" ||
          !result.unsupportedVisible || result.hasBypassAdvice || result.bypassLinks !== 0 ||
          (expectedCode === "WEBGPU_ADAPTER_UNAVAILABLE" && result.adapterIntercepted !== true)) {
        throw new Error(`Edge unsupported UI failed ${expectedCode}: ${JSON.stringify(result)}`);
      }
      if (recover) {
        const recovered = await page.evaluate(async () => {
          globalThis.__forge3dNullAdapterInjected = false;
          const viewer = await window.__forge3dInteractiveViewer.create();
          const value = { status: document.querySelector("#status")?.value,
            publicCode: window.__forge3dInteractiveViewer.errorCode,
            unsupportedVisible: document.querySelector("#unsupported")?.hidden === false };
          viewer.dispose();
          return value;
        });
        if (recovered.status !== "ready" || recovered.publicCode !== null || recovered.unsupportedVisible) {
          throw new Error(`Edge unsupported UI retained stale state: ${JSON.stringify(recovered)}`);
        }
        result.recovered = true;
      }
      return result;
    },
  });
}

async function runUnrelatedErrorCase({ browser, fixtureUrl }) {
  return withIsolatedBrowserContext({
    browser, fixtureUrl,
    inspect: async (page) => {
      const wasmUrl = new URL("missing-forge3d.wasm", fixtureUrl).href;
      const result = await page.evaluate(async (url) => {
        try { await window.__forge3dInteractiveViewer.create({ runtime: { wasmUrl: url } }); } catch (error) {
          return { code: error?.code ?? null, status: document.querySelector("#status")?.value,
            unsupportedVisible: document.querySelector("#unsupported")?.hidden === false };
        }
        return null;
      }, wasmUrl);
      if (!result || result.code !== "WASM_LOAD_FAILED" || result.status !== "WASM_LOAD_FAILED" || result.unsupportedVisible) {
        throw new Error(`Edge unrelated error classification changed: ${JSON.stringify(result)}`);
      }
      return result;
    },
  });
}

function installMissingGpu() {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
}

function installNullAdapter() {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error("positive workload did not expose navigator.gpu");
  globalThis.__forge3dNullAdapterInjected = true;
  globalThis.__forge3dRequestAdapterIntercepted = false;
  const proxy = new Proxy(gpu, {
    get(target, property) {
      if (property === "requestAdapter") return async () => {
        if (globalThis.__forge3dNullAdapterInjected) {
          globalThis.__forge3dRequestAdapterIntercepted = true;
          return null;
        }
        return target.requestAdapter();
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => proxy });
}
