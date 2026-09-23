import { OwnedDomResources } from "./viewer-controls.js";

type DisposeResource = () => void;

export interface RenderSchedulerOptions {
  submitFrame: () => void | boolean;
  canRender?: () => boolean;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  document?: Document;
  pageTarget?: EventTarget;
  resources?: OwnedDomResources;
  onError?: (error: unknown) => void;
  /**
   * Runs at the start of every owned animation frame with its timestamp.
   * Returning `true` keeps the scheduler animating (another frame is
   * requested after this one), e.g. while fly-mode movement keys are held.
   */
  onFrame?: (timestamp: number) => boolean;
}

/**
 * Invalidation-based renderer with exactly one owned animation-frame slot.
 */
export class RenderScheduler {
  readonly #submitFrame: () => void | boolean;
  readonly #canRender: () => boolean;
  readonly #requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelAnimationFrame: (handle: number) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onFrame: ((timestamp: number) => boolean) | undefined;
  readonly #resources: OwnedDomResources;
  readonly #ownsResources: boolean;
  readonly #disposeListeners: DisposeResource[] = [];
  readonly #animationFrames = new Set<number>();
  #dirty = false;
  #suspended = false;
  #documentHidden = false;
  #pageHidden = false;
  #disposed = false;
  #renderRequests = 0;
  #submittedFrames = 0;
  #skippedFrames = 0;

  constructor(options: RenderSchedulerOptions) {
    this.#submitFrame = options.submitFrame;
    this.#canRender = options.canRender ?? (() => true);
    this.#requestAnimationFrame =
      options.requestAnimationFrame ?? defaultRequestAnimationFrame;
    this.#cancelAnimationFrame =
      options.cancelAnimationFrame ?? defaultCancelAnimationFrame;
    this.#onError = options.onError ?? reportAsync;
    this.#onFrame = options.onFrame;
    this.#resources = options.resources ?? new OwnedDomResources();
    this.#ownsResources = options.resources === undefined;

    const lifecycleDocument =
      options.document ??
      (typeof document === "undefined" ? undefined : document);
    if (lifecycleDocument !== undefined) {
      this.#documentHidden = lifecycleDocument.visibilityState === "hidden";
      this.#disposeListeners.push(
        this.#resources.listen(lifecycleDocument, "visibilitychange", () => {
          this.#setDocumentHidden(
            lifecycleDocument.visibilityState === "hidden",
          );
        }),
      );
    }

    const pageTarget =
      options.pageTarget ??
      (typeof window === "undefined" ? undefined : window);
    if (pageTarget !== undefined) {
      this.#disposeListeners.push(
        this.#resources.listen(pageTarget, "pagehide", () => {
          this.#pageHidden = true;
          this.#cancelPendingFrame();
        }),
        this.#resources.listen(pageTarget, "pageshow", () => {
          this.#pageHidden = false;
          this.#dirty = true;
          this.#scheduleIfPossible();
        }),
      );
    }
  }

  get renderRequests(): number {
    return this.#renderRequests;
  }

  get submittedFrames(): number {
    return this.#submittedFrames;
  }

  get skippedFrames(): number {
    return this.#skippedFrames;
  }

  get pendingAnimationFrame(): boolean {
    return this.#animationFrames.size > 0;
  }

  get ownedAnimationFrameCount(): number {
    return this.#animationFrames.size;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  requestRender(): void {
    if (this.#disposed) {
      return;
    }
    this.#renderRequests += 1;
    this.#dirty = true;
    this.#scheduleIfPossible();
  }

  suspend(): void {
    if (this.#disposed || this.#suspended) {
      return;
    }
    this.#suspended = true;
    this.#cancelPendingFrame();
  }

  resume(): void {
    if (this.#disposed || !this.#suspended) {
      return;
    }
    this.#suspended = false;
    this.#scheduleIfPossible();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#dirty = false;
    this.#cancelPendingFrame();
    for (const dispose of this.#disposeListeners.splice(0)) {
      dispose();
    }
    if (this.#ownsResources) {
      this.#resources.dispose();
    }
  }

  #setDocumentHidden(hidden: boolean): void {
    if (this.#documentHidden === hidden || this.#disposed) {
      return;
    }
    this.#documentHidden = hidden;
    if (hidden) {
      this.#cancelPendingFrame();
      return;
    }
    this.#dirty = true;
    this.#scheduleIfPossible();
  }

  #scheduleIfPossible(): void {
    if (
      this.#animationFrames.size > 0 ||
      !this.#dirty ||
      !this.#isRunnable()
    ) {
      return;
    }
    let handle = 0;
    handle = this.#requestAnimationFrame((timestamp) => {
      this.#animationFrames.delete(handle);
      this.#submitIfPossible(timestamp);
    });
    this.#animationFrames.add(handle);
  }

  #submitIfPossible(timestamp: number): void {
    if (!this.#dirty || !this.#isRunnable()) {
      return;
    }
    let animating = false;
    if (this.#onFrame !== undefined) {
      try {
        animating = this.#onFrame(timestamp) === true;
      } catch (error) {
        this.#onError(error);
      }
      if (!this.#isRunnable()) {
        return;
      }
    }
    this.#dirty = false;
    try {
      const submitted = this.#submitFrame();
      if (submitted === false) {
        this.#skippedFrames += 1;
      } else {
        this.#submittedFrames += 1;
      }
    } catch (error) {
      this.#onError(error);
    }
    if (animating) {
      this.#dirty = true;
    }
    this.#scheduleIfPossible();
  }

  #isRunnable(): boolean {
    return (
      !this.#disposed &&
      !this.#suspended &&
      !this.#documentHidden &&
      !this.#pageHidden &&
      this.#canRender()
    );
  }

  #cancelPendingFrame(): void {
    if (this.#animationFrames.size === 0) {
      return;
    }
    for (const handle of this.#animationFrames) {
      this.#cancelAnimationFrame(handle);
    }
    this.#animationFrames.clear();
  }
}

function defaultRequestAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    throw new Error("requestAnimationFrame is unavailable");
  }
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelAnimationFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  }
}

function reportAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}
