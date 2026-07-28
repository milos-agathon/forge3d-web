import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

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
  }
}
