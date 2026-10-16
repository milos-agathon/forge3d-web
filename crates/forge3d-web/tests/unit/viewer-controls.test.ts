import { describe, expect, it, vi } from "vitest";

import { OrbitController } from "../../src-ts/orbit-controller.js";
import {
  OwnedDomResources,
  ViewerControls,
} from "../../src-ts/viewer-controls.js";

describe("ViewerControls", () => {
  it("captures pointer drags, invalidates state, and releases cancellation", () => {
    const canvas = new FakeCanvas();
    const controller = new OrbitController();
    const resources = new OwnedDomResources();
    let invalidations = 0;
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      controller,
      {},
      () => {
        invalidations += 1;
      },
      resources,
    );

    canvas.dispatchEvent(pointerEvent("pointerdown", 7, "mouse", 0, 10, 20));
    expect(canvas.captures.has(7)).toBe(true);
    expect(resources.activePointers).toBe(1);
    canvas.dispatchEvent(pointerEvent("pointermove", 7, "mouse", 0, 30, 50));
    expect(invalidations).toBe(1);
    expect(controller.getView().yawDegrees).not.toBe(0);
    canvas.dispatchEvent(pointerEvent("pointerleave", 7, "mouse", 0, 40, 60));
    expect(resources.activePointers).toBe(1);
    canvas.dispatchEvent(pointerEvent("pointercancel", 7, "mouse", 0, 40, 60));
    expect(resources.activePointers).toBe(0);
    expect(canvas.captures.has(7)).toBe(false);

    controls.dispose();
    expect(resources.ownedListeners).toBe(0);
  });

  it("performs order-independent two-pointer pan and pinch", () => {
    const run = (firstId: number, secondId: number) => {
      const canvas = new FakeCanvas();
      const controller = new OrbitController();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        controller,
      );
      canvas.dispatchEvent(pointerEvent("pointerdown", firstId, "touch", 0, 0, 0));
      canvas.dispatchEvent(pointerEvent("pointerdown", secondId, "touch", 0, 100, 0));
      canvas.dispatchEvent(pointerEvent("pointermove", firstId, "touch", 0, -10, 10));
      canvas.dispatchEvent(pointerEvent("pointermove", secondId, "touch", 0, 120, 10));
      const view = controller.getView();
      controls.dispose();
      return view;
    };

    expect(run(20, 10)).toEqual(run(10, 20));
  });

  it("derives mouse orbit and pan from buttons across both chord orders", () => {
    for (const [downButton, moves] of [
      [0, [1, 3, 1]],
      [2, [2, 3, 2]],
      [0, [1, 5, 1]],
      [1, [4, 5, 4]],
    ] as const) {
      const canvas = new FakeCanvas();
      const controller = new OrbitController();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        controller,
      );
      canvas.dispatchEvent(pointerEvent("pointerdown", 1, "mouse", downButton, 10, 10));
      let previous = controller.getView();
      canvas.dispatchEvent(pointerEvent("pointermove", 1, "mouse", -1, 20, 20, moves[0]));
      let current = controller.getView();
      expect(current.yawDegrees === previous.yawDegrees).toBe((moves[0] & 0b110) !== 0);
      expect(current.target.every((value, index) => value === previous.target[index])).toBe((moves[0] & 0b110) === 0);
      previous = current;
      canvas.dispatchEvent(pointerEvent("pointermove", 1, "mouse", -1, 30, 30, moves[1]));
      current = controller.getView();
      expect(current.target).not.toEqual(previous.target);
      expect(current.yawDegrees).toBe(previous.yawDegrees);
      previous = current;
      canvas.dispatchEvent(pointerEvent("pointermove", 1, "mouse", -1, 40, 40, moves[2]));
      current = controller.getView();
      expect(current.yawDegrees === previous.yawDegrees).toBe((moves[2] & 0b110) !== 0);
      expect(current.target.every((value, index) => value === previous.target[index])).toBe((moves[2] & 0b110) === 0);
      controls.dispose();
    }
  });

  it("terminates zero-button and unsupported-only mouse moves before mutation", () => {
    for (const buttons of [0, 8]) {
      const canvas = new FakeCanvas();
      const controller = new OrbitController();
      const resources = new OwnedDomResources();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        controller,
        {},
        () => {},
        resources,
      );
      const before = controller.getView();
      canvas.dispatchEvent(pointerEvent("pointerdown", 2, "mouse", 0, 10, 10));
      canvas.dispatchEvent(pointerEvent("pointermove", 2, "mouse", -1, 30, 30, buttons));
      expect(controller.getView()).toEqual(before);
      expect(resources.activePointers).toBe(0);
      expect(canvas.captures.has(2)).toBe(false);
      controls.dispose();
    }
  });

  it("handles capture failure, outside leave, cancellation, capture loss, and duplicate terminals", () => {
    const canvas = new FakeCanvas();
    canvas.captureFails = true;
    const resources = new OwnedDomResources();
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      new OrbitController(),
      {},
      () => {},
      resources,
    );
    canvas.dispatchEvent(pointerEvent("pointerdown", 3, "mouse", 0, 10, 10));
    canvas.dispatchEvent(pointerEvent("pointerleave", 3, "mouse", -1, -1, -1));
    expect(resources.activePointers).toBe(0);
    canvas.dispatchEvent(pointerEvent("pointercancel", 3, "mouse", -1, -1, -1));
    canvas.captureFails = false;
    canvas.dispatchEvent(pointerEvent("pointerdown", 4, "mouse", 0, 10, 10));
    canvas.dispatchEvent(pointerEvent("lostpointercapture", 4, "mouse", -1, 10, 10, 0));
    canvas.dispatchEvent(pointerEvent("pointerup", 4, "mouse", 0, 10, 10, 0));
    expect(resources.activePointers).toBe(0);
    controls.dispose();
  });

  it("consumes wheel, right context menu, and focused keyboard only while enabled", () => {
    const canvas = new FakeCanvas();
    const controller = new OrbitController();
    let invalidations = 0;
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      controller,
      {},
      () => {
        invalidations += 1;
      },
    );

    const wheel = eventWith("wheel", { deltaY: 100, deltaMode: 0 });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(invalidations).toBe(1);

    canvas.dispatchEvent(pointerEvent("pointerdown", 1, "mouse", 2, 0, 0));
    const contextMenu = eventWith("contextmenu", { button: 2, clientX: 0, clientY: 0 });
    canvas.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);

    const keyboard = eventWith("keydown", { key: "ArrowLeft", shiftKey: false });
    canvas.dispatchEvent(keyboard);
    expect(keyboard.defaultPrevented).toBe(true);

    controls.setEnabled(false);
    const disabledWheel = eventWith("wheel", { deltaY: 100, deltaMode: 0 });
    canvas.dispatchEvent(disabledWheel);
    expect(disabledWheel.defaultPrevented).toBe(false);
    controls.dispose();
  });

  it("scopes one bounded context-menu suppression to its right-button gesture", () => {
    vi.useFakeTimers();
    const canvas = new FakeCanvas();
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      new OrbitController(),
    );
    const menu = (shiftKey = false, button = 2, x = 0, y = 0) =>
      eventWith("contextmenu", { shiftKey, button, clientX: x, clientY: y });

    canvas.dispatchEvent(pointerEvent("pointerdown", 1, "mouse", 2, 0, 0, 2));
    const beforeRelease = menu();
    canvas.dispatchEvent(beforeRelease);
    expect(beforeRelease.defaultPrevented).toBe(true);
    expect(canvas.dispatchEvent(menu())).toBe(true);
    canvas.dispatchEvent(pointerEvent("pointerup", 1, "mouse", 2, 0, 0, 0));

    canvas.dispatchEvent(pointerEvent("pointerdown", 2, "mouse", 2, 0, 0, 2));
    canvas.dispatchEvent(pointerEvent("pointerup", 2, "mouse", 2, 0, 0, 0));
    const afterRelease = menu();
    canvas.dispatchEvent(afterRelease);
    expect(afterRelease.defaultPrevented).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 3, "mouse", 2, 0, 0, 2));
    canvas.dispatchEvent(pointerEvent("pointerup", 3, "mouse", 2, 0, 0, 0));
    canvas.dispatchEvent(pointerEvent("lostpointercapture", 3, "mouse", -1, 0, 0, 0));
    const afterImplicitLoss = menu();
    canvas.dispatchEvent(afterImplicitLoss);
    expect(afterImplicitLoss.defaultPrevented).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 30, "mouse", 2, 0, 0, 2));
    canvas.dispatchEvent(pointerEvent("pointerup", 30, "mouse", 2, 0, 0, 0));
    const keyboardMenu = menu(false, 0);
    canvas.dispatchEvent(keyboardMenu);
    expect(keyboardMenu.defaultPrevented).toBe(false);
    const correlatedMenu = menu();
    canvas.dispatchEvent(correlatedMenu);
    expect(correlatedMenu.defaultPrevented).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 31, "mouse", 2, 10, 10, 2));
    canvas.dispatchEvent(pointerEvent("pointerup", 31, "mouse", 2, 10, 10, 0));
    expect(canvas.dispatchEvent(menu(false, 2, 20, 20))).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(canvas.dispatchEvent(menu(false, 2, 10, 10))).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 4, "mouse", 2, 0, 0, 2));
    canvas.dispatchEvent(pointerEvent("lostpointercapture", 4, "mouse", -1, 0, 0, 0));
    expect(canvas.dispatchEvent(menu())).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 32, "mouse", 2, 0, 0, 2));
    canvas.dispatchEvent(pointerEvent("pointercancel", 32, "mouse", -1, 0, 0, 0));
    expect(canvas.dispatchEvent(menu())).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 5, "mouse", 2, 0, 0, 2));
    const shifted = menu(true);
    canvas.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);
    expect(canvas.dispatchEvent(menu())).toBe(true);
    canvas.dispatchEvent(pointerEvent("pointercancel", 5, "mouse", -1, 0, 0, 0));

    const shiftDown = pointerEvent("pointerdown", 6, "mouse", 2, 0, 0, 2, true);
    canvas.dispatchEvent(shiftDown);
    expect(shiftDown.defaultPrevented).toBe(false);
    expect(canvas.dispatchEvent(menu())).toBe(true);

    canvas.dispatchEvent(pointerEvent("pointerdown", 33, "mouse", 2, 0, 0, 2));
    canvas.dispatchEvent(pointerEvent("pointerup", 33, "mouse", 2, 0, 0, 0));
    expect(vi.getTimerCount()).toBe(1);
    controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("arms right-menu authorization once when right joins either mouse chord", () => {
    for (const initialButtons of [1, 4]) {
      const canvas = new FakeCanvas();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        new OrbitController(),
      );
      canvas.dispatchEvent(pointerEvent("pointerdown", 8, "mouse", initialButtons === 1 ? 0 : 1, 0, 0, initialButtons));
      canvas.dispatchEvent(pointerEvent("pointermove", 8, "mouse", -1, 5, 5, initialButtons | 2));
      const menu = eventWith("contextmenu", { button: 2, clientX: 5, clientY: 5 });
      canvas.dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(true);
      expect(canvas.dispatchEvent(eventWith("contextmenu", { button: 2, clientX: 5, clientY: 5 }))).toBe(true);
      controls.dispose();
    }

    const canvas = new FakeCanvas();
    const controls = new ViewerControls(canvas as unknown as HTMLCanvasElement, new OrbitController());
    canvas.dispatchEvent(pointerEvent("pointerdown", 9, "mouse", 0, 0, 0, 1));
    canvas.dispatchEvent(pointerEvent("pointermove", 9, "mouse", -1, 5, 5, 3, true));
    expect(canvas.dispatchEvent(eventWith("contextmenu", { button: 2, clientX: 5, clientY: 5 }))).toBe(true);
    controls.dispose();
  });

  it("preserves the original right-release menu deadline across chord release orders", () => {
    vi.useFakeTimers();
    const menu = (canvas: FakeCanvas, x: number) => {
      const event = eventWith("contextmenu", { button: 2, clientX: x, clientY: 0 });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };

    const rightFirst = new FakeCanvas();
    const rightFirstControls = new ViewerControls(rightFirst as unknown as HTMLCanvasElement, new OrbitController());
    rightFirst.dispatchEvent(pointerEvent("pointerdown", 40, "mouse", 2, 0, 0, 2));
    rightFirst.dispatchEvent(pointerEvent("pointermove", 40, "mouse", -1, 1, 0, 3));
    rightFirst.dispatchEvent(pointerEvent("pointermove", 40, "mouse", -1, 2, 0, 1));
    expect(vi.getTimerCount()).toBe(1);
    rightFirst.dispatchEvent(pointerEvent("pointerup", 40, "mouse", 0, 2, 0, 0));
    expect(vi.getTimerCount()).toBe(1);
    expect(menu(rightFirst, 2)).toBe(true);
    expect(menu(rightFirst, 2)).toBe(false);
    rightFirstControls.dispose();

    const rightLast = new FakeCanvas();
    const rightLastControls = new ViewerControls(rightLast as unknown as HTMLCanvasElement, new OrbitController());
    rightLast.dispatchEvent(pointerEvent("pointerdown", 41, "mouse", 0, 0, 0, 1));
    rightLast.dispatchEvent(pointerEvent("pointermove", 41, "mouse", -1, 1, 0, 3));
    rightLast.dispatchEvent(pointerEvent("pointermove", 41, "mouse", -1, 2, 0, 2));
    rightLast.dispatchEvent(pointerEvent("pointerup", 41, "mouse", 2, 3, 0, 0));
    expect(menu(rightLast, 3)).toBe(true);
    rightLastControls.dispose();

    const middleRight = new FakeCanvas();
    const middleRightControls = new ViewerControls(middleRight as unknown as HTMLCanvasElement, new OrbitController());
    middleRight.dispatchEvent(pointerEvent("pointerdown", 42, "mouse", 1, 0, 0, 4));
    middleRight.dispatchEvent(pointerEvent("pointermove", 42, "mouse", -1, 1, 0, 6));
    middleRight.dispatchEvent(pointerEvent("pointermove", 42, "mouse", -1, 2, 0, 4));
    expect(menu(middleRight, 2)).toBe(true);
    middleRightControls.dispose();

    const expiring = new FakeCanvas();
    const expiringControls = new ViewerControls(expiring as unknown as HTMLCanvasElement, new OrbitController());
    expiring.dispatchEvent(pointerEvent("pointerdown", 43, "mouse", 2, 0, 0, 2));
    expiring.dispatchEvent(pointerEvent("pointermove", 43, "mouse", -1, 1, 0, 3));
    expiring.dispatchEvent(pointerEvent("pointermove", 43, "mouse", -1, 2, 0, 1));
    vi.advanceTimersByTime(500);
    expiring.dispatchEvent(pointerEvent("pointerup", 43, "mouse", 0, 2, 0, 0));
    vi.advanceTimersByTime(501);
    expect(menu(expiring, 2)).toBe(false);
    expiringControls.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("normalizes equivalent pixel, line, and page wheel deltas in both directions and clamps bounds", () => {
    const distanceFor = (deltaY: number, deltaMode: number) => {
      const canvas = new FakeCanvas();
      const controller = new OrbitController();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        controller,
      );
      canvas.dispatchEvent(eventWith("wheel", { deltaY, deltaMode }));
      const distance = controller.getView().distance;
      controls.dispose();
      return distance;
    };
    for (const direction of [-1, 1]) {
      expect(distanceFor(direction * 160, 0)).toBe(distanceFor(direction * 10, 1));
      expect(distanceFor(direction * 160, 0)).toBe(distanceFor(direction * 0.4, 2));
    }
    expect(distanceFor(-1e9, 0)).toBeCloseTo(0.01, 12);
    expect(distanceFor(1e9, 0)).toBeCloseTo(1_000_000, 6);
  });

  it("clears gesture state while disabled, suspended, and disposed", () => {
    for (const terminate of [
      (controls: ViewerControls) => controls.setEnabled(false),
      (controls: ViewerControls) => controls.suspend(),
      (controls: ViewerControls) => controls.dispose(),
    ]) {
      const canvas = new FakeCanvas();
      const resources = new OwnedDomResources();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        new OrbitController(),
        {},
        () => {},
        resources,
      );
      canvas.dispatchEvent(pointerEvent("pointerdown", 10, "mouse", 2, 0, 0, 2));
      terminate(controls);
      expect(resources.activePointers).toBe(0);
      expect(canvas.dispatchEvent(eventWith("contextmenu", { button: 2, clientX: 0, clientY: 0 }))).toBe(true);
      controls.dispose();
    }
  });

  it("restores canvas touch action and tabindex across fifty instances", () => {
    for (let index = 0; index < 50; index += 1) {
      const canvas = new FakeCanvas();
      canvas.style.touchAction = "pan-y";
      canvas.setAttribute("tabindex", "-1");
      const resources = new OwnedDomResources();
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        new OrbitController(),
        {},
        () => {},
        resources,
      );
      expect(canvas.style.touchAction).toBe("none");
      expect(canvas.getAttribute("tabindex")).toBe("0");
      controls.dispose();
      expect(resources.ownedListeners).toBe(0);
      expect(resources.activePointers).toBe(0);
      expect(canvas.style.touchAction).toBe("pan-y");
      expect(canvas.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("restores absent, present, important touch-action and tabindex variants exactly", () => {
    for (const sample of [
      { touch: null, priority: "", tabindex: null },
      { touch: "pan-y", priority: "", tabindex: "3" },
      { touch: "manipulation", priority: "important", tabindex: "-1" },
    ]) {
      const canvas = new FakeCanvas();
      canvas.style.setProperty("color", "red", "important");
      if (sample.touch !== null) {
        canvas.style.setProperty("touch-action", sample.touch, sample.priority);
      }
      if (sample.tabindex !== null) canvas.setAttribute("tabindex", sample.tabindex);
      const controls = new ViewerControls(
        canvas as unknown as HTMLCanvasElement,
        new OrbitController(),
      );
      expect(canvas.style.touchAction).toBe("none");
      expect(canvas.style.getPropertyPriority("touch-action")).toBe("");
      controls.dispose();
      expect(canvas.style.getPropertyValue("touch-action")).toBe(sample.touch ?? "");
      expect(canvas.style.getPropertyPriority("touch-action")).toBe(sample.priority);
      expect(canvas.style.has("touch-action")).toBe(sample.touch !== null);
      expect(canvas.style.getPropertyValue("color")).toBe("red");
      expect(canvas.style.getPropertyPriority("color")).toBe("important");
      expect(canvas.getAttribute("tabindex")).toBe(sample.tabindex);
    }
  });

  it("owns no Safari Gesture Event listeners before or after disposal", () => {
    const canvas = new FakeCanvas();
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      new OrbitController(),
    );
    expect(canvas.listenerTypes.some((type) => type.startsWith("gesture"))).toBe(false);
    controls.dispose();
    expect(canvas.activeListenerTypes.some((type) => type.startsWith("gesture"))).toBe(false);
  });

  it("does not suppress browser touch gestures while controls are disabled", () => {
    const canvas = new FakeCanvas();
    canvas.style.touchAction = "pan-y";
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      new OrbitController(),
      { enabled: false },
    );
    expect(canvas.style.touchAction).toBe("pan-y");
    controls.setEnabled(true);
    expect(canvas.style.touchAction).toBe("none");
    controls.setEnabled(false);
    expect(canvas.style.touchAction).toBe("pan-y");
    controls.dispose();
  });
});

class FakeCanvas extends EventTarget {
  readonly style = new FakeStyle();
  readonly captures = new Set<number>();
  readonly #attributes = new Map<string, string>();
  readonly listenerTypes: string[] = [];
  readonly activeListenerTypes: string[] = [];
  captureFails = false;
  clientHeight = 400;

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    this.listenerTypes.push(type);
    this.activeListenerTypes.push(type);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
    const index = this.activeListenerTypes.indexOf(type);
    if (index >= 0) this.activeListenerTypes.splice(index, 1);
    super.removeEventListener(type, listener, options);
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  setPointerCapture(pointerId: number): void {
    if (this.captureFails) throw new Error("capture unavailable");
    this.captures.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captures.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captures.delete(pointerId);
  }

  focus(): void {}

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 800,
      height: 400,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      toJSON: () => ({}),
    };
  }
}

class FakeStyle {
  readonly #properties = new Map<string, { value: string; priority: string }>();

  get length(): number { return this.#properties.size; }
  get touchAction(): string { return this.getPropertyValue("touch-action"); }
  set touchAction(value: string) {
    if (value) this.setProperty("touch-action", value);
    else this.removeProperty("touch-action");
  }
  item(index: number): string { return [...this.#properties.keys()][index] ?? ""; }
  has(property: string): boolean { return this.#properties.has(property); }
  getPropertyValue(property: string): string { return this.#properties.get(property)?.value ?? ""; }
  getPropertyPriority(property: string): string { return this.#properties.get(property)?.priority ?? ""; }
  setProperty(property: string, value: string, priority = ""): void {
    this.#properties.set(property, { value, priority });
  }
  removeProperty(property: string): string {
    const previous = this.getPropertyValue(property);
    this.#properties.delete(property);
    return previous;
  }
}

function pointerEvent(
  type: string,
  pointerId: number,
  pointerType: string,
  button: number,
  clientX: number,
  clientY: number,
  buttons = button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 0,
  shiftKey = false,
): Event {
  return eventWith(type, {
    pointerId,
    pointerType,
    button,
    buttons,
    shiftKey,
    clientX,
    clientY,
  });
}

function eventWith(type: string, properties: Record<string, unknown>): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}
