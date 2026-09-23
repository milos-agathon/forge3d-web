import type { CameraInputEvent, OrbitControlsOptions } from "./index.js";
import { CameraController } from "./camera-controllers.js";
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
  x: number;
  y: number;
  buttons: number;
}

interface ContextMenuAuthorization {
  pointerId: number;
  x: number;
  y: number;
  phase: "active" | "pending";
}

interface InlineStyleSnapshot {
  readonly present: boolean;
  readonly value: string;
  readonly priority: string;
}

const ORBIT_DEGREES_PER_CSS_PIXEL = 0.25;
const KEYBOARD_ORBIT_DEGREES = 2;
const KEYBOARD_PAN_CSS_PIXELS = 10;
const KEYBOARD_ZOOM_DELTA = 120;
const CONTEXT_MENU_AUTHORIZATION_MS = 1_000;
const CONTEXT_MENU_COORDINATE_TOLERANCE = 2;

/** Longest fly-mode movement step taken from one animation frame. */
const MAX_FLY_FRAME_SECONDS = 0.1;

export class ViewerControls {
  readonly #canvas: HTMLCanvasElement;
  readonly #camera: CameraController;
  readonly #invalidate: () => void;
  readonly #resources: OwnedDomResources;
  readonly #ownsResources: boolean;
  readonly #disposeListeners: DisposeResource[] = [];
  readonly #pointers = new Map<number, ActivePointer>();
  readonly #keyboard: boolean;
  readonly #previousTouchAction: InlineStyleSnapshot;
  readonly #previousTabIndex: string | null;
  #enabled: boolean;
  #suspended = false;
  #disposed = false;
  #contextMenuAuthorization: ContextMenuAuthorization | null = null;
  #contextMenuTimer: ReturnType<typeof setTimeout> | null = null;
  #lastFlyFrame: number | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    controller: OrbitController | CameraController,
    options: OrbitControlsOptions = {},
    onInvalidate: () => void = () => {},
    resources?: OwnedDomResources,
  ) {
    this.#canvas = canvas;
    this.#camera =
      controller instanceof CameraController
        ? controller
        : new CameraController(
            {
              ...(options.mode !== undefined ? { mode: options.mode } : {}),
              ...(options.fly !== undefined ? { flyOptions: options.fly } : {}),
              ...(options.bindings !== undefined ? { bindings: options.bindings } : {}),
            },
            controller,
          );
    this.#invalidate = onInvalidate;
    this.#resources = resources ?? new OwnedDomResources();
    this.#ownsResources = resources === undefined;
    this.#enabled = options.enabled ?? true;
    this.#keyboard = options.keyboard ?? true;
    this.#previousTouchAction = snapshotInlineStyle(canvas.style, "touch-action");
    this.#previousTabIndex = canvas.getAttribute("tabindex");

    this.#applyTouchAction();
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

  /** Orbit/fly controller driven by this DOM input. */
  get cameraController(): CameraController {
    return this.#camera;
  }

  /**
   * Scheduler frame hook: advances fly-mode movement by the elapsed frame
   * time while movement keys are held. Returns whether frames must continue.
   */
  onAnimationFrame(timestamp: number): boolean {
    if (!this.#isInteractive() || !this.#camera.moving) {
      this.#lastFlyFrame = undefined;
      return false;
    }
    const previous = this.#lastFlyFrame;
    this.#lastFlyFrame = timestamp;
    const deltaSeconds =
      previous === undefined || !Number.isFinite(timestamp)
        ? 0
        : Math.min(Math.max((timestamp - previous) / 1000, 0), MAX_FLY_FRAME_SECONDS);
    if (this.#apply({ type: "tick", deltaSeconds })) {
      this.#invalidate();
    }
    return true;
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    if (this.#enabled === enabled) {
      return;
    }
    this.#enabled = enabled;
    this.#applyTouchAction();
    if (!enabled) {
      this.#cancelAllPointers();
      this.#releaseKeys();
    }
  }

  suspend(): void {
    if (this.#disposed || this.#suspended) {
      return;
    }
    this.#suspended = true;
    this.#cancelAllPointers();
    this.#releaseKeys();
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
    this.#releaseKeys();
    for (const dispose of this.#disposeListeners.splice(0)) {
      dispose();
    }
    restoreInlineStyle(
      this.#canvas.style,
      "touch-action",
      this.#previousTouchAction,
    );
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
      this.#onPointerUp(event as PointerEvent),
    );
    this.#listen("pointercancel", (event) =>
      this.#finishPointer((event as PointerEvent).pointerId, false),
    );
    this.#listen("lostpointercapture", (event) =>
      this.#finishPointer((event as PointerEvent).pointerId, false),
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
    this.#listen("keyup", (event) => this.#onKeyUp(event as KeyboardEvent));
    this.#listen("blur", () => this.#releaseKeys());
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
    if (
      event.pointerType === "mouse" &&
      event.button === 2 &&
      event.shiftKey
    ) {
      this.#clearContextMenuAuthorization();
      return;
    }
    if (!this.#isInteractive() || !isAcceptedPointer(event, this.#pointers)) {
      return;
    }
    const pointer: ActivePointer = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      buttons: event.pointerType === "mouse" ? event.buttons & 0b111 : 0,
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
      this.#armContextMenuAuthorization(event.pointerId, event.clientX, event.clientY);
    } else {
      this.#clearContextMenuAuthorization();
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

    if (previousPointer.pointerType === "mouse") {
      const supportedButtons = event.buttons & 0b111;
      if (supportedButtons === 0) {
        this.#finishPointer(event.pointerId, false);
        return;
      }
      if (this.#contextMenuAuthorization?.phase === "pending") {
        this.#clearContextMenuAuthorization();
      }
      const newlyPressedRight =
        (previousPointer.buttons & 0b010) === 0 && (supportedButtons & 0b010) !== 0;
      const newlyReleasedRight =
        (previousPointer.buttons & 0b010) !== 0 && (supportedButtons & 0b010) === 0;
      if (newlyReleasedRight) {
        this.#pendContextMenuAuthorization(event.pointerId, event.clientX, event.clientY);
      }
      if (newlyPressedRight) {
        if (event.shiftKey) {
          this.#clearContextMenuAuthorization();
        } else {
          this.#armContextMenuAuthorization(event.pointerId, event.clientX, event.clientY);
        }
      } else if (
        this.#contextMenuAuthorization?.phase === "active" &&
        this.#contextMenuAuthorization.pointerId === event.pointerId &&
        (supportedButtons & 0b010) !== 0
      ) {
        this.#contextMenuAuthorization.x = event.clientX;
        this.#contextMenuAuthorization.y = event.clientY;
      }
    }

    const previousTouches = this.#gesturePointers();
    const nextPointer: ActivePointer = {
      ...previousPointer,
      x: event.clientX,
      y: event.clientY,
      buttons: previousPointer.pointerType === "mouse" ? event.buttons & 0b111 : 0,
    };
    this.#pointers.set(event.pointerId, nextPointer);
    const nextTouches = this.#gesturePointers();

    let changed = false;
    if (this.#camera.mode === "fly") {
      if (nextTouches.length < 2) {
        const lookSpeed = this.#camera.fly.lookSpeed;
        changed = this.#apply({
          type: "look",
          deltaYawDegrees: -(nextPointer.x - previousPointer.x) * lookSpeed,
          deltaPitchDegrees: -(nextPointer.y - previousPointer.y) * lookSpeed,
        });
      }
    } else if (nextTouches.length >= 2 && previousTouches.length >= 2) {
      const previousGesture = twoPointerGesture(previousTouches);
      const nextGesture = twoPointerGesture(nextTouches);
      const height = positiveCanvasHeight(this.#canvas);
      changed =
        this.#apply({
          type: "pan",
          deltaX: nextGesture.centroidX - previousGesture.centroidX,
          deltaY: nextGesture.centroidY - previousGesture.centroidY,
          viewportHeight: height,
        }) || changed;
      if (previousGesture.distance > 0 && nextGesture.distance > 0) {
        const pinchDelta =
          -Math.log(nextGesture.distance / previousGesture.distance) * 1000;
        changed = this.#apply({ type: "zoom", delta: pinchDelta }) || changed;
      }
    } else if (nextTouches.length === 1) {
      changed = this.#apply({
        type: "orbit",
        deltaYawDegrees: (nextPointer.x - previousPointer.x) * ORBIT_DEGREES_PER_CSS_PIXEL,
        deltaPitchDegrees: (nextPointer.y - previousPointer.y) * ORBIT_DEGREES_PER_CSS_PIXEL,
      });
    } else if (previousPointer.pointerType === "mouse") {
      const deltaX = nextPointer.x - previousPointer.x;
      const deltaY = nextPointer.y - previousPointer.y;
      if ((event.buttons & 0b110) !== 0) {
        changed = this.#apply({
          type: "pan",
          deltaX,
          deltaY,
          viewportHeight: positiveCanvasHeight(this.#canvas),
        });
      } else {
        changed = this.#apply({
          type: "orbit",
          deltaYawDegrees: deltaX * ORBIT_DEGREES_PER_CSS_PIXEL,
          deltaPitchDegrees: deltaY * ORBIT_DEGREES_PER_CSS_PIXEL,
        });
      }
    }
    if (changed) {
      this.#invalidate();
    }
    event.preventDefault();
  }

  #onPointerUp(event: PointerEvent): void {
    const pointer = this.#pointers.get(event.pointerId);
    if (pointer === undefined) {
      return;
    }
    const supportedButtons = event.pointerType === "mouse" ? event.buttons & 0b111 : 0;
    const releasedRight =
      pointer.pointerType === "mouse" &&
      (pointer.buttons & 0b010) !== 0 &&
      (supportedButtons & 0b010) === 0;
    if (releasedRight) {
      this.#pendContextMenuAuthorization(event.pointerId, event.clientX, event.clientY);
    }
    if (supportedButtons !== 0) {
      this.#pointers.set(event.pointerId, {
        ...pointer,
        x: event.clientX,
        y: event.clientY,
        buttons: supportedButtons,
      });
      return;
    }
    this.#finishPointer(event.pointerId, true);
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
    this.#finishPointer(event.pointerId, false);
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
    if (this.#apply({ type: "zoom", delta: event.deltaY * scale })) {
      this.#invalidate();
    }
    event.preventDefault();
  }

  #onContextMenu(event: MouseEvent): void {
    if (event.shiftKey) {
      this.#clearContextMenuAuthorization();
      return;
    }
    const authorization = this.#contextMenuAuthorization;
    if (
      !this.#isInteractive() ||
      authorization === null ||
      event.button !== 2 ||
      Math.abs(event.clientX - authorization.x) > CONTEXT_MENU_COORDINATE_TOLERANCE ||
      Math.abs(event.clientY - authorization.y) > CONTEXT_MENU_COORDINATE_TOLERANCE
    ) {
      return;
    }
    this.#clearContextMenuAuthorization();
    event.preventDefault();
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (!this.#isInteractive() || !this.#keyboard) {
      return;
    }
    if (this.#handleBoundKey(event)) {
      return;
    }
    if (this.#camera.mode === "fly") {
      return;
    }
    let consumed = true;
    let changed = false;
    const orbit = (deltaYawDegrees: number, deltaPitchDegrees: number): boolean =>
      this.#apply({ type: "orbit", deltaYawDegrees, deltaPitchDegrees });
    const pan = (deltaX: number, deltaY: number): boolean =>
      this.#apply({
        type: "pan",
        deltaX,
        deltaY,
        viewportHeight: positiveCanvasHeight(this.#canvas),
      });
    switch (event.key) {
      case "ArrowLeft":
        changed = event.shiftKey
          ? pan(-KEYBOARD_PAN_CSS_PIXELS, 0)
          : orbit(-KEYBOARD_ORBIT_DEGREES, 0);
        break;
      case "ArrowRight":
        changed = event.shiftKey
          ? pan(KEYBOARD_PAN_CSS_PIXELS, 0)
          : orbit(KEYBOARD_ORBIT_DEGREES, 0);
        break;
      case "ArrowUp":
        changed = event.shiftKey
          ? pan(0, -KEYBOARD_PAN_CSS_PIXELS)
          : orbit(0, -KEYBOARD_ORBIT_DEGREES);
        break;
      case "ArrowDown":
        changed = event.shiftKey
          ? pan(0, KEYBOARD_PAN_CSS_PIXELS)
          : orbit(0, KEYBOARD_ORBIT_DEGREES);
        break;
      case "+":
      case "=":
        changed = this.#apply({ type: "zoom", delta: -KEYBOARD_ZOOM_DELTA });
        break;
      case "-":
      case "_":
        changed = this.#apply({ type: "zoom", delta: KEYBOARD_ZOOM_DELTA });
        break;
      case "Home":
        changed = this.#apply({ type: "reset" });
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

  /**
   * Routes bound keys (mode toggle in both modes; movement, boost and reset
   * in fly mode). Returns whether the event was consumed.
   */
  #handleBoundKey(event: KeyboardEvent): boolean {
    const code = event.code;
    if (typeof code !== "string" || code === "") {
      return false;
    }
    const bindings = this.#camera.bindings;
    const isToggle = bindings.toggleMode.includes(code);
    const isFlyKey =
      this.#camera.mode === "fly" &&
      (bindings.forward.includes(code) ||
        bindings.backward.includes(code) ||
        bindings.left.includes(code) ||
        bindings.right.includes(code) ||
        bindings.up.includes(code) ||
        bindings.down.includes(code) ||
        bindings.boost.includes(code) ||
        bindings.reset.includes(code));
    if (!isToggle && !isFlyKey) {
      return false;
    }
    event.preventDefault();
    if (event.repeat) {
      return true;
    }
    const changed = this.#apply({ type: "key", code, pressed: true });
    if (changed || this.#camera.moving) {
      this.#invalidate();
    }
    return true;
  }

  #onKeyUp(event: KeyboardEvent): void {
    const code = event.code;
    if (typeof code !== "string" || code === "") {
      return;
    }
    this.#apply({ type: "key", code, pressed: false });
  }

  #releaseKeys(): void {
    this.#lastFlyFrame = undefined;
    this.#apply({ type: "releaseKeys" });
  }

  #apply(event: CameraInputEvent): boolean {
    return this.#camera.apply(event);
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

  #finishPointer(pointerId: number, preserveContextMenu: boolean): void {
    if (!this.#pointers.delete(pointerId)) {
      return;
    }
    this.#resources.releasePointer(pointerId);
    if (
      !preserveContextMenu &&
      this.#contextMenuAuthorization?.pointerId === pointerId
    ) {
      this.#clearContextMenuAuthorization();
    }
  }

  #cancelAllPointers(): void {
    for (const pointerId of [...this.#pointers.keys()]) {
      this.#finishPointer(pointerId, false);
    }
    this.#clearContextMenuAuthorization();
  }

  #armContextMenuAuthorization(pointerId: number, x: number, y: number): void {
    this.#clearContextMenuTimer();
    this.#contextMenuAuthorization = { pointerId, x, y, phase: "active" };
  }

  #scheduleContextMenuExpiry(): void {
    this.#clearContextMenuTimer();
    this.#contextMenuTimer = setTimeout(() => {
      this.#contextMenuTimer = null;
      if (this.#contextMenuAuthorization?.phase === "pending") {
        this.#contextMenuAuthorization = null;
      }
    }, CONTEXT_MENU_AUTHORIZATION_MS);
  }

  #pendContextMenuAuthorization(pointerId: number, x: number, y: number): void {
    const authorization = this.#contextMenuAuthorization;
    if (
      authorization?.pointerId !== pointerId ||
      authorization.phase !== "active"
    ) {
      return;
    }
    authorization.x = x;
    authorization.y = y;
    authorization.phase = "pending";
    this.#scheduleContextMenuExpiry();
  }

  #clearContextMenuTimer(): void {
    if (this.#contextMenuTimer !== null) {
      clearTimeout(this.#contextMenuTimer);
      this.#contextMenuTimer = null;
    }
  }

  #clearContextMenuAuthorization(): void {
    this.#clearContextMenuTimer();
    this.#contextMenuAuthorization = null;
  }

  #applyTouchAction(): void {
    if (this.#enabled) {
      this.#canvas.style.setProperty("touch-action", "none");
    } else {
      restoreInlineStyle(
        this.#canvas.style,
        "touch-action",
        this.#previousTouchAction,
      );
    }
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

function snapshotInlineStyle(
  style: CSSStyleDeclaration,
  property: string,
): InlineStyleSnapshot {
  let present = false;
  for (let index = 0; index < style.length; index += 1) {
    if (style.item(index) === property) {
      present = true;
      break;
    }
  }
  return {
    present,
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function restoreInlineStyle(
  style: CSSStyleDeclaration,
  property: string,
  snapshot: InlineStyleSnapshot,
): void {
  if (snapshot.present) {
    style.setProperty(property, snapshot.value, snapshot.priority);
  } else {
    style.removeProperty(property);
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
