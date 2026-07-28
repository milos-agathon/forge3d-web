import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

test("duplicate facades coordinate independently in separate Window realms", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-clear.html");
  await page.evaluate(() => {
    for (const realm of ["a", "b"]) {
      const frame = document.createElement("iframe");
      frame.id = `realm-${realm}`;
      frame.src = `/examples/test-clear.html?realm=${realm}`;
      document.body.append(frame);
    }
  });
  await expect(page.locator("iframe")).toHaveCount(2);

  const frames = page
    .frames()
    .filter((frame) => frame !== page.mainFrame());
  expect(frames).toHaveLength(2);
  await Promise.all(
    frames.map((frame) =>
      frame.waitForLoadState("networkidle"),
    ),
  );

  const results = await Promise.all(
    frames.map((frame) =>
      frame.evaluate(async () => {
        const [facadeA, facadeB] = await Promise.all([
          import("/src-ts/index.ts?duplicate=a"),
          import("/src-ts/index.ts?duplicate=b"),
        ]);
        const canvasA = document.createElement("canvas");
        const canvasB = document.createElement("canvas");
        canvasA.width = canvasB.width = 32;
        canvasA.height = canvasB.height = 32;
        document.body.append(canvasA, canvasB);
        const options = {
          wasmUrl: "/pkg/forge3d_web_bg.wasm",
          width: 32,
          height: 32,
          devicePixelRatio: 1,
        };
        const [runtimeA, runtimeB] = await Promise.all([
          facadeA.Forge3DRuntime.create(canvasA, options),
          facadeB.Forge3DRuntime.create(canvasB, options),
        ]);
        const key = Symbol.for("@forge3d/web.wasm-bridge-coordinator");
        const coordinator = (globalThis as any)[key];
        const result = {
          state: coordinator?.record?.state,
          selectedUrl: coordinator?.record?.selectedUrl,
          firstDevice: runtimeA.getCapabilities().deviceState,
          secondDevice: runtimeB.getCapabilities().deviceState,
        };
        runtimeA.dispose();
        runtimeB.dispose();
        canvasA.remove();
        canvasB.remove();
        return result;
      }),
    ),
  );

  for (const result of results) {
    expect(result.state).toBe("ready");
    expect(result.selectedUrl).toContain("/pkg/forge3d_web_bg.wasm");
    expect(result.firstDevice).toBe("ready");
    expect(result.secondDevice).toBe("ready");
  }
  expect(
    await page.evaluate(() => {
      const key = Symbol.for("@forge3d/web.wasm-bridge-coordinator");
      const first = (document.querySelector("#realm-a") as HTMLIFrameElement)
        .contentWindow as any;
      const second = (document.querySelector("#realm-b") as HTMLIFrameElement)
        .contentWindow as any;
      return first[key] !== second[key];
    }),
  ).toBe(true);
});
