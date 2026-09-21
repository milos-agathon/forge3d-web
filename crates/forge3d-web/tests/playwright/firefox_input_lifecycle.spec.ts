import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

test("native mouse chords, capture loss, and Shift+right-click recover", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.evaluate(async () => {
    await window.__forge3dInteractiveViewer.create();
    const canvas = window.__forge3dInteractiveViewer.canvas;
    (window as any).__ffx04Events = [];
    (window as any).__ffx04PointerId = null;
    for (const type of ["pointerdown", "gotpointercapture", "pointercancel", "lostpointercapture", "contextmenu"]) {
      canvas.addEventListener(type, (event: Event) => {
        if (type === "pointerdown") (window as any).__ffx04PointerId = (event as PointerEvent).pointerId;
        (window as any).__ffx04Events.push({
          type,
          trusted: event.isTrusted,
          prevented: event.defaultPrevented,
          pointerId: (event as PointerEvent).pointerId ?? null,
        });
      });
    }
  });
  const canvas = page.locator("#viewer");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + 150, y: box!.y + 150 };
  await page.mouse.move(point.x, point.y);
  const initial = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.mouse.down({ button: "left" });
  await page.mouse.move(point.x + 10, point.y + 10);
  const orbit = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  expect(orbit.yawDegrees).not.toBe(initial.yawDegrees);
  expect(orbit.target).toEqual(initial.target);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(point.x + 25, point.y + 25);
  const leftRightPan = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  expect(leftRightPan.yawDegrees).toBe(orbit.yawDegrees);
  expect(leftRightPan.target).not.toEqual(orbit.target);
  await page.mouse.up({ button: "right" });
  await page.mouse.up({ button: "left" });
  await page.mouse.move(point.x + 25, point.y + 25);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(point.x + 35, point.y + 20);
  const resumedOrbit = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  expect(resumedOrbit.yawDegrees).not.toBe(leftRightPan.yawDegrees);
  expect(resumedOrbit.target).toEqual(leftRightPan.target);

  const pointer = await page.evaluate(() => ({
    id: (window as any).__ffx04PointerId,
    captured: window.__forge3dInteractiveViewer.canvas.hasPointerCapture((window as any).__ffx04PointerId),
  }));
  expect(pointer.id).toEqual(expect.any(Number));
  expect(pointer.captured).toBe(true);
  const beforeOutside = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.mouse.move(box!.x + box!.width + 20, box!.y + box!.height + 20);
  const outside = await page.evaluate(() => ({
    view: window.__forge3dInteractiveViewer.viewer.getView(),
    active: window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers,
  }));
  expect(outside.view).not.toEqual(beforeOutside);
  expect(outside.active).toBe(1);
  const lostBeforeRelease = await page.evaluate(() =>
    (window as any).__ffx04Events.filter((event: any) => event.type === "lostpointercapture").length,
  );
  await page.evaluate((pointerId) => {
    window.__forge3dInteractiveViewer.canvas.releasePointerCapture(pointerId);
  }, pointer.id);
  await page.mouse.move(box!.x + box!.width + 21, box!.y + box!.height + 21);
  await expect.poll(() => page.evaluate(() => ({
    active: window.__forge3dInteractiveViewer.viewer.getDiagnostics().activePointers,
    trustedLostCount: (window as any).__ffx04Events.filter((event: any) =>
      event.type === "lostpointercapture" && event.trusted && event.pointerId === (window as any).__ffx04PointerId).length,
  }))).toEqual({ active: 0, trustedLostCount: lostBeforeRelease + 1 });
  const afterLoss = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.mouse.move(point.x + 45, point.y + 45);
  expect(await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView())).toEqual(afterLoss);
  await page.mouse.up({ button: "left" });

  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: "middle" });
  const middleStart = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.mouse.down({ button: "right" });
  await page.mouse.move(point.x + 45, point.y + 30);
  const middleRightPan = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  expect(middleRightPan.yawDegrees).toBe(middleStart.yawDegrees);
  expect(middleRightPan.target).not.toEqual(middleStart.target);
  await page.mouse.up({ button: "right" });
  await page.mouse.up({ button: "middle" });

  await page.keyboard.down("Shift");
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.keyboard.up("Shift");
  const beforeRecovery = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(point.x + 20, point.y);
  await page.mouse.up({ button: "left" });

  const result = await page.evaluate(() => ({
    diagnostics: window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
    view: window.__forge3dInteractiveViewer.viewer.getView(),
    events: (window as any).__ffx04Events,
  }));
  expect(result.diagnostics.activePointers).toBe(0);
  expect(result.view.yawDegrees).not.toBe(beforeRecovery.yawDegrees);
  expect(result.events.some((event: any) => event.type === "gotpointercapture" && event.trusted)).toBe(true);
  expect(result.events.some((event: any) =>
    event.type === "contextmenu" && event.trusted && event.prevented)).toBe(true);
});

test("focus traversal, canvas keys, and disposal restore DOM state", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const original = await page.evaluate(async () => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    canvas.insertAdjacentHTML("beforebegin", '<button id="before">before</button>');
    canvas.insertAdjacentHTML("afterend", '<button id="after">after</button>');
    canvas.setAttribute("tabindex", "-1");
    canvas.style.setProperty("touch-action", "pan-y", "important");
    canvas.style.setProperty("outline-color", "rgb(1, 2, 3)", "important");
    await window.__forge3dInteractiveViewer.create();
    return {
      touchAction: canvas.style.getPropertyValue("touch-action"),
      touchPriority: canvas.style.getPropertyPriority("touch-action"),
      tabIndex: canvas.getAttribute("tabindex"),
    };
  });
  expect(original).toEqual({ touchAction: "none", touchPriority: "", tabIndex: "0" });
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#viewer")).toBeFocused();
  const before = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView())).not.toEqual(before);
  await page.keyboard.press("Tab");
  await expect(page.locator("#after")).toBeFocused();
  const restored = await page.evaluate(() => {
    window.__forge3dInteractiveViewer.dispose();
    const canvas = window.__forge3dInteractiveViewer.canvas;
    return {
      touchAction: canvas.style.getPropertyValue("touch-action"),
      touchPriority: canvas.style.getPropertyPriority("touch-action"),
      outline: canvas.style.getPropertyValue("outline-color"),
      outlinePriority: canvas.style.getPropertyPriority("outline-color"),
      tabIndex: canvas.getAttribute("tabindex"),
      diagnostics: window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
    };
  });
  expect(restored).toMatchObject({
    touchAction: "pan-y",
    touchPriority: "important",
    outline: "rgb(1, 2, 3)",
    outlinePriority: "important",
    tabIndex: "-1",
    diagnostics: {
      activePointers: 0,
      ownedListeners: 0,
      activeObservers: 0,
      activeRuntimes: 0,
      pendingAnimationFrame: false,
    },
  });
  const disposedView = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#after")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#before")).toBeFocused();
  await page.evaluate(() => {
    (window as any).__ffx04DisposedKeyPrevented = null;
    window.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") (window as any).__ffx04DisposedKeyPrevented = event.defaultPrevented;
    }, { once: true });
    window.__forge3dInteractiveViewer.canvas.focus();
  });
  await page.keyboard.press("ArrowLeft");
  expect(await page.evaluate(() => (window as any).__ffx04DisposedKeyPrevented)).toBe(false);
  expect(await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView())).toEqual(disposedView);

  const absentTabindex = await page.evaluate(async () => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    canvas.removeAttribute("tabindex");
    await window.__forge3dInteractiveViewer.create();
    const active = canvas.getAttribute("tabindex");
    window.__forge3dInteractiveViewer.dispose();
    return { active, restored: canvas.getAttribute("tabindex") };
  });
  expect(absentTabindex).toEqual({ active: "0", restored: null });
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#after")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#before")).toBeFocused();
});

test("zero-size suspension cancels work and resumes exactly once", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const before = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = window.__forge3dInteractiveViewer.canvas;
    canvas.style.width = "0px";
    canvas.style.height = "0px";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const suspended = viewer.getDiagnostics();
    viewer.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { suspended, afterRequest: viewer.getDiagnostics() };
  });
  expect(before.afterRequest.renderRequests).toBe(before.suspended.renderRequests + 1);
  expect(before.afterRequest.pendingAnimationFrame).toBe(false);
  expect(before.afterRequest.submittedFrames + before.afterRequest.skippedFrames)
    .toBe(before.suspended.submittedFrames + before.suspended.skippedFrames);
  await expect.poll(() => page.evaluate(() => {
    const diagnostics = window.__forge3dInteractiveViewer.viewer.getDiagnostics();
    return { pending: diagnostics.pendingAnimationFrame, frames: diagnostics.submittedFrames + diagnostics.skippedFrames };
  })).toEqual({
    pending: false,
    frames: before.suspended.submittedFrames + before.suspended.skippedFrames,
  });
  await page.evaluate(() => {
    const canvas = window.__forge3dInteractiveViewer.canvas;
    canvas.style.width = "320px";
    canvas.style.height = "320px";
  });
  await expect.poll(() => page.evaluate(() => {
    const diagnostics = window.__forge3dInteractiveViewer.viewer.getDiagnostics();
    return diagnostics.submittedFrames + diagnostics.skippedFrames;
  })).toBe(before.suspended.submittedFrames + before.suspended.skippedFrames + 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const stable = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getDiagnostics());
  expect(stable.submittedFrames + stable.skippedFrames).toBe(
    before.suspended.submittedFrames + before.suspended.skippedFrames + 1,
  );
  expect(stable.activeRuntimes).toBe(1);
  expect(stable.activeObservers).toBe(1);
});

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
