import { describe, expect, it } from "vitest";

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
    const contextMenu = eventWith("contextmenu", {});
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

  it("restores the exact canvas style attribute and tabindex across fifty instances", () => {
    for (let index = 0; index < 50; index += 1) {
      const canvas = new FakeCanvas();
      canvas.setAttribute("style", "color: red; touch-action: pan-y;");
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
      expect(canvas.getAttribute("style")).toBe("color: red; touch-action: pan-y;");
      expect(canvas.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("restores absent style and tabindex attributes without leaving empty attributes", () => {
    const canvas = new FakeCanvas();
    const controls = new ViewerControls(
      canvas as unknown as HTMLCanvasElement,
      new OrbitController(),
    );
    expect(canvas.getAttribute("style")).not.toBeNull();
    expect(canvas.getAttribute("tabindex")).toBe("0");
    controls.dispose();
    expect(canvas.getAttribute("style")).toBeNull();
    expect(canvas.getAttribute("tabindex")).toBeNull();
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
  readonly style = {
    get touchAction(): string {
      return parseStyle(this.owner.getAttribute("style")).touchAction;
    },
    set touchAction(value: string) {
      const parsed = parseStyle(this.owner.getAttribute("style"));
      parsed.touchAction = value;
      this.owner.setAttribute("style", serializeStyle(parsed));
    },
    owner: undefined as unknown as FakeCanvas,
  };
  readonly captures = new Set<number>();
  readonly #attributes = new Map<string, string>();
  readonly listenerTypes: string[] = [];
  readonly activeListenerTypes: string[] = [];
  clientHeight = 400;

  constructor() {
    super();
    this.style.owner = this;
  }

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

function parseStyle(value: string | null): { color: string; touchAction: string } {
  const declarations = new Map(
    (value ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const separator = part.indexOf(":");
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }),
  );
  return { color: declarations.get("color") ?? "", touchAction: declarations.get("touch-action") ?? "" };
}

function serializeStyle(style: { color: string; touchAction: string }): string {
  return [style.color ? `color: ${style.color};` : "", style.touchAction ? `touch-action: ${style.touchAction};` : ""].filter(Boolean).join(" ");
}

function pointerEvent(
  type: string,
  pointerId: number,
  pointerType: string,
  button: number,
  clientX: number,
  clientY: number,
): Event {
  return eventWith(type, {
    pointerId,
    pointerType,
    button,
    buttons: 1,
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
