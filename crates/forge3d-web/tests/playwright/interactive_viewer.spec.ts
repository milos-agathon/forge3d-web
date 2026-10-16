import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

test("manual fixture exposes a scrollable target outside the canvas", async ({ page }) => {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector("#viewer")!.getBoundingClientRect();
    const target = document.querySelector("#outside-scroll-target")!.getBoundingClientRect();
    const scrollable = document.documentElement.scrollHeight > window.innerHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
    return { scrollable, targetOutsideCanvas: target.top > canvas.bottom, scrollY: window.scrollY };
  });
  expect(result.scrollable).toBe(true);
  expect(result.targetOutsideCanvas).toBe(true);
  expect(result.scrollY).toBeGreaterThan(0);
});

test("pointercancel releases pending capture before the next trusted move", async ({ page, webgpuAvailability }) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.evaluate(async () => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    window.__saf04Cancel = { down: null, got: null, lost: null, move: null };
    canvas.addEventListener("pointerdown", (event) => { window.__saf04Cancel.down = event.pointerId; });
    canvas.addEventListener("gotpointercapture", (event) => { window.__saf04Cancel.got = event.pointerId; });
    canvas.addEventListener("lostpointercapture", (event) => { window.__saf04Cancel.lost = event.pointerId; });
    canvas.addEventListener("pointermove", (event) => { window.__saf04Cancel.move = event.pointerId; });
    await window.__forge3dInteractiveViewer.create();
  });
  const box = await page.locator("#viewer").boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 100);
  await page.mouse.down();
  await page.mouse.move(box!.x + 120, box!.y + 120);
  const captured = await page.evaluate(() => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    return { ...window.__saf04Cancel, hasCapture: canvas.hasPointerCapture(window.__saf04Cancel.down!),
      activePointers: window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers };
  });
  const immediate = await page.evaluate(() => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    const id = window.__saf04Cancel.down!;
    canvas.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: id, pointerType: "mouse" }));
    return { hasCapture: canvas.hasPointerCapture(id),
      activePointers: window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers };
  });
  await page.mouse.move(box!.x + 140, box!.y + 140);
  const released = await page.evaluate(() => ({ ...window.__saf04Cancel,
    hasCapture: window.__forge3dInteractiveViewer.canvas.hasPointerCapture(window.__saf04Cancel.down!),
    activePointers: window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers }));
  await page.mouse.up();
  expect(captured.got).toBe(captured.down);
  expect(captured.move).toBe(captured.down);
  expect(captured.hasCapture).toBe(true);
  expect(captured.activePointers).toBe(1);
  expect(immediate).toEqual({ hasCapture: false, activePointers: 0 });
  expect(released.lost).toBe(released.down);
  expect(released.move).toBe(released.down);
  expect(released.hasCapture).toBe(false);
  expect(released.activePointers).toBe(0);
});

test("pointercancel regression predicate rejects bookkeeping-only release", async ({ page, webgpuAvailability }) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.evaluate(async () => {
    window.__saf04Cancel = { down: null, got: null, lost: null, move: null };
    window.__forge3dInteractiveViewer.canvas.addEventListener("pointerdown", (event) => {
      window.__saf04Cancel.down = event.pointerId;
    });
    await window.__forge3dInteractiveViewer.create();
  });
  const box = await page.locator("#viewer").boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 100);
  await page.mouse.down();
  const accepted = await page.evaluate(() => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    const id = window.__saf04Cancel.down!;
    const release = canvas.releasePointerCapture.bind(canvas);
    canvas.releasePointerCapture = () => undefined;
    canvas.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: id, pointerType: "mouse" }));
    const value = !canvas.hasPointerCapture(id) &&
      window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers === 0;
    canvas.releasePointerCapture = release;
    return value;
  });
  await page.mouse.up();
  expect(accepted).toBe(false);
});

test("supports mouse, wheel, touch, and keyboard interaction", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.evaluate(() => window.__forge3dInteractiveViewer.create());

  const canvas = page.locator("#viewer");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const before = await getView(page);

  await page.mouse.move(box!.x + 160, box!.y + 160);
  await page.mouse.down();
  const pointerDownState = await page.evaluate(() => ({
    activePointers:
      window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers,
    status: window.__forge3dInteractiveViewer.viewer.status,
  }));
  expect(pointerDownState.status).toBe("ready");
  expect(pointerDownState.activePointers).toBe(1);
  await page.mouse.move(box!.x + 205, box!.y + 135, { steps: 4 });
  await page.mouse.up();
  const afterMouse = await getView(page);
  expect(afterMouse).not.toEqual(before);

  await page.mouse.wheel(0, -120);
  const afterWheel = await getView(page);
  expect(afterWheel.distance).not.toBe(afterMouse.distance);

  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  const afterKeyboard = await getView(page);
  expect(afterKeyboard).not.toEqual(afterWheel);

  await page.evaluate(() => {
    const target = window.__forge3dInteractiveViewer.canvas;
    const event = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 41,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        isPrimary: true,
      });
    target.dispatchEvent(event("pointerdown", 120, 120));
    target.dispatchEvent(event("pointermove", 145, 105));
    target.dispatchEvent(event("pointerup", 145, 105));
  });
  const afterTouch = await getView(page);
  expect(afterTouch).not.toEqual(afterKeyboard);
  expect(
    await page.evaluate(
      () => window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers,
    ),
  ).toBe(0);
});

test("explicit resize updates the backing canvas and schedules a frame", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const before = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create({
      resize: false,
    });
    return viewer.getDiagnostics().renderRequests;
  });
  await page.evaluate(() => {
    window.__forge3dInteractiveViewer.viewer.resize({
      width: 240,
      height: 180,
      devicePixelRatio: 2,
    });
  });
  await page.waitForFunction(
    (initial) =>
      window.__forge3dInteractiveViewer.viewer.getDiagnostics().renderRequests >
      initial,
    before,
  );
  await expect(page.locator("#viewer")).toHaveJSProperty("width", 480);
  await expect(page.locator("#viewer")).toHaveJSProperty("height", 360);
});

test("disabled controls leave native browser touch gestures available", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    await window.__forge3dInteractiveViewer.create({
      controls: { enabled: false },
    });
    const canvas = window.__forge3dInteractiveViewer.canvas;
    const event = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 77,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    const dispatched = canvas.dispatchEvent(event);
    return {
      dispatched,
      defaultPrevented: event.defaultPrevented,
      touchAction: canvas.style.touchAction,
    };
  });
  expect(result).toEqual({
    dispatched: true,
    defaultPrevented: false,
    touchAction: "",
  });
});

async function getView(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    window.__forge3dInteractiveViewer.viewer.getView(),
  );
}

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
    __saf04Cancel: { down: number | null; got: number | null; lost: number | null; move: number | null };
  }
}
