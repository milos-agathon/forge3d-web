import type { ResizeInput } from "./index.js";
import { OwnedDomResources } from "./viewer-controls.js";

type DisposeResource = () => void;

type MeasurementPhase = "none" | "hidden" | "awaiting-measurement";

interface CanvasMeasurement {
  cssWidth: number;
  cssHeight: number;
  devicePixelWidth?: number;
  devicePixelHeight?: number;
}

interface RawMeasurement {
  measurement: CanvasMeasurement;
  devicePixelRatio: number;
}

export interface BackingSizeConstraints {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  maxDevicePixelRatio: number;
  maxCanvasPixels: number;
  maxTextureDimension2D: number;
  devicePixelWidth?: number;
  devicePixelHeight?: number;
}

export interface BackingSize {
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  effectiveDevicePixelRatio: number;
}

export interface ResizeObserverLike {
  observe(target: Element, options?: ResizeObserverOptions): void;
  disconnect(): void;
}

export type ResizeObserverFactory = (
  callback: ResizeObserverCallback,
) => ResizeObserverLike;

export interface ResizeControllerOptions {
  canvas: HTMLCanvasElement;
  onResize: (size: ResizeInput) => void;
  onSuspendedChange?: (suspended: boolean) => void;
  maxDevicePixelRatio: number;
  maxCanvasPixels: number;
  maxTextureDimension2D: number;
  getDevicePixelRatio?: () => number;
  observerFactory?: ResizeObserverFactory;
  windowTarget?: EventTarget;
  resources?: OwnedDomResources;
}

/**
 * Converts CSS layout measurements into exact, policy-clamped backing sizes.
 */
export class ResizeController {
  readonly #canvas: HTMLCanvasElement;
  readonly #onResize: (size: ResizeInput) => void;
  readonly #onSuspendedChange: (suspended: boolean) => void;
  readonly #maxDevicePixelRatio: number;
  readonly #maxCanvasPixels: number;
  readonly #maxTextureDimension2D: number;
  readonly #getDevicePixelRatio: () => number;
  readonly #resources: OwnedDomResources;
  readonly #ownsResources: boolean;
  readonly #disposeListeners: DisposeResource[] = [];
  #disposeObserver: DisposeResource | undefined;
  #observer: ResizeObserverLike | undefined;
  #lastSize: BackingSize | undefined;
  #rawMeasurement: RawMeasurement | undefined;
  #measurementPhase: MeasurementPhase = "none";
  #bootstrapped = false;
  #suspended = true;
  #disposed = false;

  constructor(options: ResizeControllerOptions) {
    assertPositiveFinite(
      "maxDevicePixelRatio",
      options.maxDevicePixelRatio,
    );
    assertPositiveInteger("maxCanvasPixels", options.maxCanvasPixels);
    assertPositiveInteger(
      "maxTextureDimension2D",
      options.maxTextureDimension2D,
    );

    this.#canvas = options.canvas;
    this.#onResize = options.onResize;
    this.#onSuspendedChange = options.onSuspendedChange ?? (() => {});
    this.#maxDevicePixelRatio = options.maxDevicePixelRatio;
    this.#maxCanvasPixels = options.maxCanvasPixels;
    this.#maxTextureDimension2D = options.maxTextureDimension2D;
    this.#getDevicePixelRatio =
      options.getDevicePixelRatio ?? defaultDevicePixelRatio;
    this.#resources = options.resources ?? new OwnedDomResources();
    this.#ownsResources = options.resources === undefined;

    const observerFactory =
      options.observerFactory ?? defaultResizeObserverFactory();
    if (observerFactory !== undefined) {
      const observer = observerFactory((entries) => {
        if (this.#disposed || this.#measurementPhase === "hidden") {
          return;
        }
        const entry = entries.find((candidate) => candidate.target === this.#canvas);
        if (entry === undefined) {
          if (this.#measurementPhase !== "awaiting-measurement") {
            this.refresh();
          }
        } else {
          this.#commitMeasurement(measureEntry(entry));
        }
      });
      this.#observer = observer;
      this.#observeCanvas(observer);
      this.#disposeObserver = this.#resources.ownObserver(() =>
        observer.disconnect(),
      );
    }

    const windowTarget =
      options.windowTarget ??
      (typeof window === "undefined" ? undefined : window);
    if (windowTarget !== undefined) {
      this.#disposeListeners.push(
        this.#resources.listen(windowTarget, "resize", () => this.refresh()),
        this.#resources.listen(windowTarget, "pagehide", (event) => {
          if ((event as PageTransitionEvent).persisted === true) {
            this.#beginPersistedHide();
          }
        }),
        this.#resources.listen(windowTarget, "pageshow", (event) => {
          if ((event as PageTransitionEvent).persisted === true) {
            this.#restorePersistedPage();
          } else {
            this.refresh();
          }
        }),
      );
    }

    this.refresh();
    this.#bootstrapped = true;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get activeObservers(): number {
    return this.#resources.activeObservers;
  }

  get effectiveDevicePixelRatio(): number {
    return this.#lastSize?.effectiveDevicePixelRatio ?? 0;
  }

  get lastResize(): ResizeInput | undefined {
    if (this.#lastSize === undefined) {
      return undefined;
    }
    return {
      width: this.#lastSize.width,
      height: this.#lastSize.height,
      devicePixelRatio: 1,
    };
  }

  refresh(): void {
    if (this.#disposed || this.#measurementPhase !== "none") {
      return;
    }
    const rect = this.#canvas.getBoundingClientRect();
    const measurement: CanvasMeasurement = {
      cssWidth: rect.width,
      cssHeight: rect.height,
    };
    const devicePixelRatio = this.#getDevicePixelRatio();
    const cached = this.#rawMeasurement;
    if (
      cached !== undefined &&
      cached.devicePixelRatio === devicePixelRatio &&
      cached.measurement.cssWidth === measurement.cssWidth &&
      cached.measurement.cssHeight === measurement.cssHeight
    ) {
      this.#commitMeasurement(cached.measurement, devicePixelRatio);
      return;
    }
    if (this.#bootstrapped && this.#awaitObserverMeasurement()) {
      return;
    }
    this.#rawMeasurement = undefined;
    this.#commitMeasurement(measurement, devicePixelRatio, false);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#disposeObserver?.();
    this.#disposeObserver = undefined;
    this.#observer = undefined;
    for (const dispose of this.#disposeListeners.splice(0)) {
      dispose();
    }
    this.#lastSize = undefined;
    this.#rawMeasurement = undefined;
    this.#measurementPhase = "none";
    this.#bootstrapped = false;
    this.#setSuspended(true);
    if (this.#ownsResources) {
      this.#resources.dispose();
    }
  }

  #beginPersistedHide(): void {
    if (this.#disposed || this.#measurementPhase === "hidden") {
      return;
    }
    this.#lastSize = undefined;
    this.#rawMeasurement = undefined;
    this.#measurementPhase = "hidden";
    this.#setSuspended(true);
  }

  #restorePersistedPage(): void {
    if (this.#disposed || this.#measurementPhase !== "hidden") {
      return;
    }
    if (this.#awaitObserverMeasurement()) {
      return;
    }
    this.#measurementPhase = "none";
    this.refresh();
  }

  #awaitObserverMeasurement(): boolean {
    const observer = this.#observer;
    if (observer === undefined) {
      return false;
    }
    this.#rawMeasurement = undefined;
    this.#measurementPhase = "awaiting-measurement";
    this.#setSuspended(true);
    observer.disconnect();
    this.#observeCanvas(observer);
    return true;
  }

  #observeCanvas(observer: ResizeObserverLike): void {
    try {
      observer.observe(this.#canvas, {
        box: "device-pixel-content-box",
      });
    } catch {
      observer.observe(this.#canvas);
    }
  }

  #commitMeasurement(
    measurement: CanvasMeasurement,
    devicePixelRatio = this.#getDevicePixelRatio(),
    retainRawMeasurement = true,
  ): void {
    if (this.#disposed || this.#measurementPhase === "hidden") {
      return;
    }
    const constraints: BackingSizeConstraints = {
      cssWidth: measurement.cssWidth,
      cssHeight: measurement.cssHeight,
      devicePixelRatio,
      maxDevicePixelRatio: this.#maxDevicePixelRatio,
      maxCanvasPixels: this.#maxCanvasPixels,
      maxTextureDimension2D: this.#maxTextureDimension2D,
    };
    if (measurement.devicePixelWidth !== undefined) {
      constraints.devicePixelWidth = measurement.devicePixelWidth;
    }
    if (measurement.devicePixelHeight !== undefined) {
      constraints.devicePixelHeight = measurement.devicePixelHeight;
    }
    const next = computeBackingSize(constraints);
    if (next === null) {
      this.#setSuspended(true);
      return;
    }
    if (retainRawMeasurement) {
      this.#rawMeasurement = {
        measurement: { ...measurement },
        devicePixelRatio,
      };
    }
    const completesMeasurement =
      this.#measurementPhase === "awaiting-measurement";
    if (!completesMeasurement) {
      this.#setSuspended(false);
    }
    if (
      this.#lastSize?.width === next.width &&
      this.#lastSize.height === next.height
    ) {
      this.#lastSize = next;
      if (completesMeasurement) {
        this.#measurementPhase = "none";
        this.#setSuspended(false);
      }
      return;
    }
    this.#lastSize = next;
    // Passing exact physical dimensions at DPR 1 avoids a second rounding step
    // in the low-level Rust resize implementation.
    this.#onResize({
      width: next.width,
      height: next.height,
      devicePixelRatio: 1,
    });
    if (completesMeasurement) {
      this.#measurementPhase = "none";
      this.#setSuspended(false);
    }
  }

  #setSuspended(suspended: boolean): void {
    if (this.#suspended === suspended) {
      return;
    }
    this.#suspended = suspended;
    this.#onSuspendedChange(suspended);
  }
}

export function computeBackingSize(
  constraints: BackingSizeConstraints,
): BackingSize | null {
  const {
    cssWidth,
    cssHeight,
    devicePixelRatio,
    maxDevicePixelRatio,
    maxCanvasPixels,
    maxTextureDimension2D,
  } = constraints;
  assertFinite("cssWidth", cssWidth);
  assertFinite("cssHeight", cssHeight);
  if (cssWidth < 0 || cssHeight < 0) {
    throw new RangeError("CSS dimensions must not be negative");
  }
  if (cssWidth === 0 || cssHeight === 0) {
    return null;
  }
  assertPositiveFinite("devicePixelRatio", devicePixelRatio);
  assertPositiveFinite("maxDevicePixelRatio", maxDevicePixelRatio);
  assertPositiveInteger("maxCanvasPixels", maxCanvasPixels);
  assertPositiveInteger("maxTextureDimension2D", maxTextureDimension2D);

  let requestedScale = Math.min(devicePixelRatio, maxDevicePixelRatio);
  const hasDevicePixelBox =
    constraints.devicePixelWidth !== undefined &&
    constraints.devicePixelHeight !== undefined;
  if (hasDevicePixelBox) {
    assertPositiveFinite(
      "devicePixelWidth",
      constraints.devicePixelWidth as number,
    );
    assertPositiveFinite(
      "devicePixelHeight",
      constraints.devicePixelHeight as number,
    );
    requestedScale = Math.min(
      requestedScale,
      (constraints.devicePixelWidth as number) / cssWidth,
      (constraints.devicePixelHeight as number) / cssHeight,
    );
  }

  const scale = Math.min(
    requestedScale,
    maxTextureDimension2D / cssWidth,
    maxTextureDimension2D / cssHeight,
    Math.sqrt(maxCanvasPixels / (cssWidth * cssHeight)),
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("resize constraints cannot produce a positive size");
  }

  let width = Math.max(1, Math.floor(cssWidth * scale));
  let height = Math.max(1, Math.floor(cssHeight * scale));
  width = Math.min(width, maxTextureDimension2D);
  height = Math.min(height, maxTextureDimension2D);
  // Floating-point rounding near the pixel ceiling can still leave a one-pixel
  // excess. Reduce the larger dimension until the invariant is exact.
  while (width * height > maxCanvasPixels) {
    if (width / cssWidth >= height / cssHeight && width > 1) {
      width -= 1;
    } else if (height > 1) {
      height -= 1;
    } else {
      break;
    }
  }

  return {
    cssWidth,
    cssHeight,
    width,
    height,
    effectiveDevicePixelRatio: Math.min(width / cssWidth, height / cssHeight),
  };
}

function measureEntry(entry: ResizeObserverEntry): {
  cssWidth: number;
  cssHeight: number;
  devicePixelWidth?: number;
  devicePixelHeight?: number;
} {
  const contentSize = firstBoxSize(entry.contentBoxSize);
  const cssWidth = contentSize?.inlineSize ?? entry.contentRect.width;
  const cssHeight = contentSize?.blockSize ?? entry.contentRect.height;
  const deviceSize = firstBoxSize(entry.devicePixelContentBoxSize);
  const measurement: {
    cssWidth: number;
    cssHeight: number;
    devicePixelWidth?: number;
    devicePixelHeight?: number;
  } = { cssWidth, cssHeight };
  if (deviceSize !== undefined) {
    measurement.devicePixelWidth = deviceSize.inlineSize;
    measurement.devicePixelHeight = deviceSize.blockSize;
  }
  return measurement;
}

function firstBoxSize(
  value: readonly ResizeObserverSize[] | ResizeObserverSize | undefined,
): ResizeObserverSize | undefined {
  if (value === undefined) {
    return undefined;
  }
  return "inlineSize" in value ? value : value[0];
}

function defaultResizeObserverFactory(): ResizeObserverFactory | undefined {
  if (typeof ResizeObserver === "undefined") {
    return undefined;
  }
  return (callback) => new ResizeObserver(callback);
}

function defaultDevicePixelRatio(): number {
  const ratio =
    typeof globalThis.devicePixelRatio === "number"
      ? globalThis.devicePixelRatio
      : 1;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}

function assertPositiveFinite(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
