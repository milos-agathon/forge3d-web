import type { APIRequestContext, Page } from "@playwright/test";

import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

test("real facade bundles share one pending and ready bridge record", async ({
  page,
  request,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-clear.html");
  const baseline = await metrics(request);
  const routeId = `hold-${Date.now()}`;
  const wasmUrl = `/tests/realm-fixture/runtime.wasm?id=${routeId}`;
  const resultPromise = page.evaluate(async (wasmUrl) => {
    const wasm = WebAssembly as any;
    const instantiate = wasm.instantiate;
    const instantiateStreaming = wasm.instantiateStreaming;
    let initCalls = 0;
    wasm.instantiate = async (...args: any[]) => {
      initCalls += 1;
      return instantiate.apply(WebAssembly, args);
    };
    wasm.instantiateStreaming = async (...args: any[]) => {
      initCalls += 1;
      return instantiateStreaming.apply(WebAssembly, args);
    };
    try {
      const [a, b] = await Promise.all([
        import("/tests/realm-fixture/a/index.js"),
        import("/tests/realm-fixture/b/index.js"),
      ]);
      const canvasA = document.createElement("canvas");
      const canvasB = document.createElement("canvas");
      canvasA.width = canvasB.width = 32;
      canvasA.height = canvasB.height = 32;
      document.body.append(canvasA, canvasB);
      const options = { wasmUrl, width: 32, height: 32, devicePixelRatio: 1 };
      const createA = a.Forge3DRuntime.create(canvasA, options);
      const key = Symbol.for("@forge3d/web.wasm-bridge-coordinator");
      const coordinator = (globalThis as any)[key];
      const bridgePromise = coordinator.record.promise;
      const createB = b.Forge3DRuntime.create(canvasB, options);
      const sameBridgePromise = coordinator.record.promise === bridgePromise;
      const pendingCode = await b.Forge3DRuntime.create(document.createElement("canvas"), {
        ...options,
        wasmUrl: "/tests/realm-fixture/runtime-other.wasm",
      }).then(() => undefined, (error: any) => error.code);
      const [runtimeA, runtimeB] = await Promise.all([createA, createB]);
      const readyCode = await a.Forge3DRuntime.create(document.createElement("canvas"), {
        ...options,
        wasmUrl: "/tests/realm-fixture/runtime-other.wasm",
      }).then(() => undefined, (error: any) => error.code);
      runtimeA.dispose();
      runtimeB.dispose();
      canvasA.remove();
      canvasB.remove();
      return {
        sameBridgePromise,
        pendingCode,
        readyCode,
        initCalls,
        readyRetained: coordinator.record.state === "ready" &&
          coordinator.record.promise === bridgePromise,
      };
    } finally {
      wasm.instantiate = instantiate;
      wasm.instantiateStreaming = instantiateStreaming;
    }
  }, wasmUrl);

  await expect.poll(async () => (await metrics(request)).held.includes(routeId)).toBe(true);
  expect((await metrics(request)).assetFetches - baseline.assetFetches).toBe(1);
  expect((await metrics(request)).bridgeFetches - baseline.bridgeFetches).toBe(1);
  expect((await request.post(`/tests/realm-fixture/release?id=${routeId}`)).ok()).toBe(true);
  expect(await resultPromise).toEqual({
    sameBridgePromise: true,
    pendingCode: "INVALID_INPUT",
    readyCode: "INVALID_INPUT",
    initCalls: 1,
    readyRetained: true,
  });
  expect((await metrics(request)).assetFetches - baseline.assetFetches).toBe(1);
  expect((await metrics(request)).bridgeFetches - baseline.bridgeFetches).toBe(1);

  const separate = await createFrame(page, "real-window-boundary");
  const separateWasmUrl = `/tests/realm-fixture/runtime.wasm?id=separate-${Date.now()}`;
  const separateResult = await separate.evaluate(async (wasmUrl) => {
    const facade = await import("/tests/realm-fixture/a/index.js");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    document.body.append(canvas);
    const runtime = await facade.Forge3DRuntime.create(canvas, {
      wasmUrl,
      width: 32,
      height: 32,
      devicePixelRatio: 1,
    });
    runtime.dispose();
    canvas.remove();
    return (globalThis as any)[
      Symbol.for("@forge3d/web.wasm-bridge-coordinator")
    ].record.state;
  }, separateWasmUrl);
  expect(separateResult).toBe("ready");
  expect(await page.evaluate(() => {
    const key = Symbol.for("@forge3d/web.wasm-bridge-coordinator");
    const frame = document.querySelector("#real-window-boundary") as HTMLIFrameElement;
    return (globalThis as any)[key] !== (frame.contentWindow as any)[key];
  })).toBe(true);
});

test("public loader retries the same canonical route after wrong MIME", async ({
  page,
  request,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-clear.html");
  const baseline = await metrics(request);
  const frame = await createFrame(page, "real-mime-retry");
  const routeId = `mime-retry-${Date.now()}`;
  const result = await frame.evaluate(async (routeId) => {
    const facade = await import("/tests/realm-fixture/a/index.js");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    document.body.append(canvas);
    const options = {
      wasmUrl: `/tests/realm-fixture/runtime.wasm?id=${routeId}`,
      width: 32,
      height: 32,
      devicePixelRatio: 1,
    };
    const firstCode = await facade.Forge3DRuntime.create(canvas, options)
      .then(() => undefined, (error: any) => error.code);
    const runtime = await facade.Forge3DRuntime.create(canvas, options);
    const state = (globalThis as any)[
      Symbol.for("@forge3d/web.wasm-bridge-coordinator")
    ].record.state;
    runtime.dispose();
    canvas.remove();
    return { firstCode, state };
  }, routeId);
  expect(result).toEqual({ firstCode: "WASM_LOAD_FAILED", state: "ready" });
  expect((await metrics(request)).assetFetches - baseline.assetFetches).toBe(2);
  expect((await metrics(request)).bridgeFetches - baseline.bridgeFetches).toBe(1);
});

test("both real bundles preserve an incompatible coordinator exactly", async ({
  page,
  request,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-clear.html");
  const baseline = await metrics(request);
  const frame = await createFrame(page, "real-incompatible");
  const result = await frame.evaluate(async () => {
    const wasm = WebAssembly as any;
    const instantiate = wasm.instantiate;
    const instantiateStreaming = wasm.instantiateStreaming;
    const originalFetch = globalThis.fetch;
    let initCalls = 0;
    let fetches = 0;
    wasm.instantiate = async (...args: any[]) => {
      initCalls += 1;
      return instantiate.apply(WebAssembly, args);
    };
    wasm.instantiateStreaming = async (...args: any[]) => {
      initCalls += 1;
      return instantiateStreaming.apply(WebAssembly, args);
    };
    globalThis.fetch = (...args) => {
      fetches += 1;
      return originalFetch(...args);
    };
    const key = Symbol.for("@forge3d/web.wasm-bridge-coordinator");
    const incompatible = Object.freeze({ schemaVersion: 99, sentinel: "unchanged" });
    Object.defineProperty(globalThis, key, {
      value: incompatible,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    const contents = JSON.stringify(incompatible);
    const codes: string[] = [];
    try {
      for (const url of [
        "/tests/realm-fixture/a/index.js",
        "/tests/realm-fixture/b/index.js",
      ]) {
        const facade = await import(url);
        const code = await facade.Forge3DRuntime.create(document.createElement("canvas"), {
          wasmUrl: "/tests/realm-fixture/runtime.wasm?id=never",
        }).then(() => undefined, (error: any) => error.code);
        codes.push(code);
      }
      const after = Object.getOwnPropertyDescriptor(globalThis, key);
      return {
        codes,
        sameObject: (globalThis as any)[key] === incompatible,
        sameDescriptor: before?.value === after?.value &&
          before?.enumerable === after?.enumerable &&
          before?.configurable === after?.configurable &&
          before?.writable === after?.writable,
        sameContents: JSON.stringify((globalThis as any)[key]) === contents,
        fetches,
        initCalls,
      };
    } finally {
      globalThis.fetch = originalFetch;
      wasm.instantiate = instantiate;
      wasm.instantiateStreaming = instantiateStreaming;
    }
  });
  expect(result).toEqual({
    codes: ["INTERNAL_ERROR", "INTERNAL_ERROR"],
    sameObject: true,
    sameDescriptor: true,
    sameContents: true,
    fetches: 0,
    initCalls: 0,
  });
  expect((await metrics(request)).assetFetches).toBe(baseline.assetFetches);
  expect((await metrics(request)).bridgeFetches).toBe(baseline.bridgeFetches);
});

async function metrics(request: APIRequestContext): Promise<{
  assetFetches: number;
  bridgeFetches: number;
  held: string[];
}> {
  const response = await request.get("/tests/realm-fixture/metrics");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createFrame(page: Page, id: string) {
  await page.evaluate((id) => {
    const frame = document.createElement("iframe");
    frame.id = id;
    frame.src = `/examples/test-clear.html?realm=${encodeURIComponent(id)}`;
    document.body.append(frame);
  }, id);
  const handle = await page.locator(`#${id}`).elementHandle();
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) {
    throw new Error(`failed to create Window realm ${id}`);
  }
  await frame.waitForLoadState("networkidle");
  return frame;
}
