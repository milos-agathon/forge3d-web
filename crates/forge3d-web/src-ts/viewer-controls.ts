import type { OrbitControlsOptions } from "./index.js";
import { OrbitController } from "./orbit-controller.js";

type DisposeResource = () => void;

/**
 * Explicit ownership registry for viewer DOM resources. Diagnostics are driven
 * by this registry rather than attempting to inspect browser-global state.
 */
export class OwnedDomResources {
  readonly #listeners = new Set<DisposeResource>();
  readonly #observers = new Set<DisposeResource>();
  readonly #pointers = new Map<number, DisposeResource>();
  #disposed = false;

  get ownedListeners(): number {
    return this.#listeners.size;
  }

  get activeObservers(): number {
    return this.#observers.size;
  }

  get activePointers(): number {
    return this.#pointers.size;
  }

  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): DisposeResource {
    this.#assertActive();
    target.addEventListener(type, listener, options);
    let active = true;
    const dispose = (): void => {
      if (!active) {
        return;
      }
      active = false;
      target.removeEventListener(type, listener, options);
      this.#listeners.delete(dispose);
    };
    this.#listeners.add(dispose);
    return dispose;
  }

  ownObserver(disconnect: DisposeResource): DisposeResource {
    this.#assertActive();
    let active = true;
    const dispose = (): void => {
      if (!active) {
        return;
      }
      active = false;
      try {
        disconnect();
      } finally {
        this.#observers.delete(dispose);
      }
    };
    this.#observers.add(dispose);
    return dispose;
  }

  trackPointer(pointerId: number, release: DisposeResource): boolean {
    this.#assertActive();
    if (this.#pointers.has(pointerId)) {
      return false;
    }
    this.#pointers.set(pointerId, release);
    return true;
  }

  releasePointer(pointerId: number): void {
    const release = this.#pointers.get(pointerId);
    if (release === undefined) {
      return;
    }
    this.#pointers.delete(pointerId);
    release();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const pointerId of [...this.#pointers.keys()]) {
      this.releasePointer(pointerId);
    }
    for (const dispose of [...this.#observers]) {
      dispose();
    }
    for (const dispose of [...this.#listeners]) {
      dispose();
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("OwnedDomResources is disposed");
    }
  }
}

interface ActivePointer {
  pointerId: number;
  pointerType: string;
  button: number;
  x: number;
  y: number;
}

const ORBIT_DEGREES_PER_CSS_PIXEL = 0.25;
const KEYBOARD_ORBIT_DEGREES = 2;
const KEYBOARD_PAN_CSS_PIXELS = 10;
const KEYBOARD_ZOOM_DELTA = 120;

export class ViewerControls {
  readonly #canvas: HTMLCanvasElement;
  readonly #controller: OrbitController;
  readonly #invalidate: () => void;
  readonly #resources: OwnedDomResources;
  readonly #ownsResources: boolean;
  readonly #disposeListeners: DisposeResource[] = [];
  readonly #pointers = new Map<number, ActivePointer>();
  readonly #keyboard: boolean;
  readonly #previousTouchAction: string;
  readonly #previousTabIndex: string | null;
  #enabled: boolean;
  #suspended = false;
  #disposed = false;
  #rightButtonConsumed = false;

  constructor(
    canvas: HTMLCanvasElement,
    controller: OrbitController,
    options: OrbitControlsOptions = {},
    onInvalidate: () => void = () => {},
    resources?: OwnedDomResources,
  ) {
    this.#canvas = canvas;
    this.#controller = controller;
    this.#invalidate = onInvalidate;
    this.#resources = resources ?? new OwnedDomResources();
    this.#ownsResources = resources === undefined;
    this.#enabled = options.enabled ?? true;
    this.#keyboard = options.keyboard ?? true;
    this.#previousTouchAction = canvas.style.touchAction;
    this.#previousTabIndex = canvas.getAttribute("tabindex");

    canvas.style.touchAction = this.#enabled
      ? "none"
      : this.#previousTouchAction;
    canvas.setAttribute("tabindex", "0");
    this.#attachListeners();
  }

  get ownedListeners(): number {
    return this.#resources.ownedListeners;
  }

  get activePointers(): number {
    return this.#resources.activePointers;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    if (this.#enabled === enabled) {
      return;
    }
    this.#enabled = enabled;
    this.#canvas.style.touchAction = enabled
      ? "none"
      : this.#previousTouchAction;
    if (!enabled) {
      this.#cancelAllPointers();
    }
  }

  suspend(): void {
    if (this.#disposed || this.#suspended) {
      return;
    }
    this.#suspended = true;
    this.#cancelAllPointers();
  }

  resume(): void {
    if (!this.#disposed) {
      this.#suspended = false;
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelAllPointers();
    for (const dispose of this.#disposeListeners.splice(0)) {
      dispose();
    }
    this.#canvas.style.touchAction = this.#previousTouchAction;
    if (this.#previousTabIndex === null) {
      this.#canvas.removeAttribute("tabindex");
    } else {
      this.#canvas.setAttribute("tabindex", this.#previousTabIndex);
    }
    if (this.#ownsResources) {
      this.#resources.dispose();
    }
  }

  #attachListeners(): void {
    this.#listen("pointerdown", (event) =>
      this.#onPointerDown(event as PointerEvent),
    );
    this.#listen("pointermove", (event) =>
      this.#onPointerMove(event as PointerEvent),
    );
    this.#listen("pointerup", (event) =>
      this.#finishPointer((event as PointerEvent).pointerId),
    );
    this.#listen("pointercancel", (event) =>
      this.#finishPointer((event as PointerEvent).pointerId),
    );
    this.#listen("lostpointercapture", (event) =>
      this.#finishPointer((event as PointerEvent).pointerId),
    );
    this.#listen("pointerleave", (event) =>
      this.#onPointerLeave(event as PointerEvent),
    );
    this.#listen("wheel", (event) => this.#onWheel(event as WheelEvent), {
      passive: false,
    });
    this.#listen("contextmenu", (event) =>
      this.#onContextMenu(event as MouseEvent),
    );
    this.#listen("keydown", (event) => this.#onKeyDown(event as KeyboardEvent));
  }

  #listen(
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    this.#disposeListeners.push(
      this.#resources.listen(this.#canvas, type, listener, options),
    );
  }

  #onPointerDown(event: PointerEvent): void {
    if (!this.#isInteractive() || !isAcceptedPointer(event, this.#pointers)) {
      return;
    }
    const pointer: ActivePointer = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      x: event.clientX,
      y: event.clientY,
    };
    this.#pointers.set(event.pointerId, pointer);
    const tracked = this.#resources.trackPointer(event.pointerId, () => {
      try {
        if (this.#canvas.hasPointerCapture(event.pointerId)) {
          this.#canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Capture can already have been released by browser lifecycle events.
      }
    });
    if (!tracked) {
      this.#pointers.delete(event.pointerId);
      return;
    }

    try {
      this.#canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer remains usable while it is over the canvas.
    }
    try {
      this.#canvas.focus({ preventScroll: true });
    } catch {
      this.#canvas.focus();
    }
    if (event.pointerType === "mouse" && event.button === 2) {
      this.#rightButtonConsumed = true;
    }
    event.preventDefault();
  }

  #onPointerMove(event: PointerEvent): void {
    if (!this.#isInteractive()) {
      return;
    }
    const previousPointer = this.#pointers.get(event.pointerId);
    if (previousPointer === undefined) {
      return;
    }

    const previousTouches = this.#gesturePointers();
    const nextPointer: ActivePointer = {
      ...previousPointer,
      x: event.clientX,
      y: event.clientY,
    };
    this.#pointers.set(event.pointerId, nextPointer);
    const nextTouches = this.#gesturePointers();

    let changed = false;
    if (nextTouches.length >= 2 && previousTouches.length >= 2) {
      const previousGesture = twoPointerGesture(previousTouches);
      const nextGesture = twoPointerGesture(nextTouches);
      const height = positiveCanvasHeight(this.#canvas);
      changed =
        this.#controller.panBy(
          nextGesture.centroidX - previousGesture.centroidX,
          nextGesture.centroidY - previousGesture.centroidY,
          height,
        ) || changed;
      if (previousGesture.distance > 0 && nextGesture.distance > 0) {
        const pinchDelta =
          -Math.log(nextGesture.distance / previousGesture.distance) * 1000;
        changed = this.#controller.zoomBy(pinchDelta) || changed;
      }
    } else if (nextTouches.length === 1) {
      changed = this.#controller.orbitBy(
        (nextPointer.x - previousPointer.x) * ORBIT_DEGREES_PER_CSS_PIXEL,
        (nextPointer.y - previousPointer.y) * ORBIT_DEGREES_PER_CSS_PIXEL,
      );
    } else if (previousPointer.pointerType === "mouse") {
      const deltaX = nextPointer.x - previousPointer.x;
      const deltaY = nextPointer.y - previousPointer.y;
      if (previousPointer.button === 0) {
        changed = this.#controller.orbitBy(
          deltaX * ORBIT_DEGREES_PER_CSS_PIXEL,
          deltaY * ORBIT_DEGREES_PER_CSS_PIXEL,
        );
      } else {
        changed = this.#controller.panBy(
          deltaX,
          deltaY,
          positiveCanvasHeight(this.#canvas),
        );
      }
    }
    if (changed) {
      this.#invalidate();
    }
    event.preventDefault();
  }

  #onPointerLeave(event: PointerEvent): void {
    if (!this.#pointers.has(event.pointerId)) {
      return;
    }
    try {
      if (this.#canvas.hasPointerCapture(event.pointerId)) {
        return;
      }
    } catch {
      // A fake or detached canvas may not be able to query capture.
    }
    this.#finishPointer(event.pointerId);
  }

  #onWheel(event: WheelEvent): void {
    if (!this.#isInteractive() || !Number.isFinite(event.deltaY)) {
      return;
    }
    const scale =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? positiveCanvasHeight(this.#canvas)
          : 1;
    if (this.#controller.zoomBy(event.deltaY * scale)) {
      this.#invalidate();
    }
    event.preventDefault();
  }

  #onContextMenu(event: MouseEvent): void {
    if (!this.#enabled || !this.#rightButtonConsumed) {
      return;
    }
    this.#rightButtonConsumed = false;
    event.preventDefault();
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (!this.#isInteractive() || !this.#keyboard) {
      return;
    }
    let consumed = true;
    let changed = false;
    switch (event.key) {
      case "ArrowLeft":
        changed = event.shiftKey
          ? this.#controller.panBy(
              -KEYBOARD_PAN_CSS_PIXELS,
              0,
              positiveCanvasHeight(this.#canvas),
            )
          : this.#controller.orbitBy(-KEYBOARD_ORBIT_DEGREES, 0);
        break;
      case "ArrowRight":
        changed = event.shiftKey
          ? this.#controller.panBy(
              KEYBOARD_PAN_CSS_PIXELS,
              0,
              positiveCanvasHeight(this.#canvas),
            )
          : this.#controller.orbitBy(KEYBOARD_ORBIT_DEGREES, 0);
        break;
      case "ArrowUp":
        changed = event.shiftKey
          ? this.#controller.panBy(
              0,
              -KEYBOARD_PAN_CSS_PIXELS,
              positiveCanvasHeight(this.#canvas),
            )
          : this.#controller.orbitBy(0, -KEYBOARD_ORBIT_DEGREES);
        break;
      case "ArrowDown":
        changed = event.shiftKey
          ? this.#controller.panBy(
              0,
              KEYBOARD_PAN_CSS_PIXELS,
              positiveCanvasHeight(this.#canvas),
            )
          : this.#controller.orbitBy(0, KEYBOARD_ORBIT_DEGREES);
        break;
      case "+":
      case "=":
        changed = this.#controller.zoomBy(-KEYBOARD_ZOOM_DELTA);
        break;
      case "-":
      case "_":
        changed = this.#controller.zoomBy(KEYBOARD_ZOOM_DELTA);
        break;
      case "Home":
        changed = this.#controller.reset();
        break;
      default:
        consumed = false;
    }
    if (!consumed) {
      return;
    }
    if (changed) {
      this.#invalidate();
    }
    event.preventDefault();
  }

  #gesturePointers(): ActivePointer[] {
    return [...this.#pointers.values()]
      .filter(
        (pointer) =>
          pointer.pointerType === "touch" || pointer.pointerType === "pen",
      )
      .sort((left, right) => left.pointerId - right.pointerId)
      .slice(0, 2);
  }

  #finishPointer(pointerId: number): void {
    if (!this.#pointers.delete(pointerId)) {
      return;
    }
    this.#resources.releasePointer(pointerId);
  }

  #cancelAllPointers(): void {
    for (const pointerId of [...this.#pointers.keys()]) {
      this.#finishPointer(pointerId);
    }
    this.#rightButtonConsumed = false;
  }

  #isInteractive(): boolean {
    return this.#enabled && !this.#suspended && !this.#disposed;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("ViewerControls is disposed");
    }
  }
}

function isAcceptedPointer(
  event: PointerEvent,
  pointers: ReadonlyMap<number, ActivePointer>,
): boolean {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    return false;
  }
  if (event.pointerType === "mouse") {
    return (
      ![...pointers.values()].some(
        (pointer) => pointer.pointerType === "mouse",
      ) &&
      (event.button === 0 || event.button === 1 || event.button === 2)
    );
  }
  return event.pointerType === "touch" || event.pointerType === "pen";
}

function positiveCanvasHeight(canvas: HTMLCanvasElement): number {
  const height = canvas.getBoundingClientRect().height || canvas.clientHeight;
  return Number.isFinite(height) && height > 0 ? height : 1;
}

function twoPointerGesture(pointers: readonly ActivePointer[]): {
  centroidX: number;
  centroidY: number;
  distance: number;
} {
  const first = pointers[0];
  const second = pointers[1];
  if (first === undefined || second === undefined) {
    throw new Error("twoPointerGesture requires two pointers");
  }
  return {
    centroidX: (first.x + second.x) / 2,
    centroidY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}
