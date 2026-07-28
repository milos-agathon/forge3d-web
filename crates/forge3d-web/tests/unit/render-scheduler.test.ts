import { describe, expect, it } from "vitest";

import { RenderScheduler } from "../../src-ts/render-scheduler.js";
import { OwnedDomResources } from "../../src-ts/viewer-controls.js";

describe("RenderScheduler", () => {
  it("coalesces one hundred invalidations into one frame", () => {
    const raf = new FakeAnimationFrames();
    let submissions = 0;
    const scheduler = new RenderScheduler({
      submitFrame: () => {
        submissions += 1;
      },
      requestAnimationFrame: raf.request,
      cancelAnimationFrame: raf.cancel,
    });

    for (let index = 0; index < 100; index += 1) {
      scheduler.requestRender();
    }
    expect(raf.pending).toBe(1);
    expect(scheduler.renderRequests).toBe(100);
    expect(scheduler.pendingAnimationFrame).toBe(true);
    raf.flush();
    expect(submissions).toBe(1);
    expect(scheduler.submittedFrames).toBe(1);
    expect(scheduler.pendingAnimationFrame).toBe(false);
  });

  it("retains dirtiness while suspended and cancels every RAF", () => {
    const raf = new FakeAnimationFrames();
    let submissions = 0;
    const scheduler = new RenderScheduler({
      submitFrame: () => {
        submissions += 1;
      },
      requestAnimationFrame: raf.request,
      cancelAnimationFrame: raf.cancel,
    });

    scheduler.requestRender();
    scheduler.suspend();
    expect(raf.pending).toBe(0);
    expect(scheduler.dirty).toBe(true);
    scheduler.resume();
    raf.flush();
    expect(submissions).toBe(1);
    scheduler.requestRender();
    scheduler.dispose();
    expect(raf.pending).toBe(0);
    raf.flush();
    expect(submissions).toBe(1);
  });

  it("pauses for visibility and BFCache lifecycle without duplicating listeners", () => {
    const raf = new FakeAnimationFrames();
    const lifecycleDocument = new FakeDocument();
    const page = new EventTarget();
    const resources = new OwnedDomResources();
    let submissions = 0;
    const scheduler = new RenderScheduler({
      submitFrame: () => {
        submissions += 1;
      },
      requestAnimationFrame: raf.request,
      cancelAnimationFrame: raf.cancel,
      document: lifecycleDocument as unknown as Document,
      pageTarget: page,
      resources,
    });
    expect(resources.ownedListeners).toBe(3);

    scheduler.requestRender();
    lifecycleDocument.visibilityState = "hidden";
    lifecycleDocument.dispatchEvent(new Event("visibilitychange"));
    expect(raf.pending).toBe(0);
    lifecycleDocument.visibilityState = "visible";
    lifecycleDocument.dispatchEvent(new Event("visibilitychange"));
    raf.flush();
    expect(submissions).toBe(1);

    scheduler.requestRender();
    page.dispatchEvent(new Event("pagehide"));
    expect(raf.pending).toBe(0);
    page.dispatchEvent(new Event("pageshow"));
    expect(raf.pending).toBe(1);
    raf.flush();
    expect(submissions).toBe(2);

    scheduler.dispose();
    expect(resources.ownedListeners).toBe(0);
  });

  it("tracks skipped submissions separately", () => {
    const raf = new FakeAnimationFrames();
    const scheduler = new RenderScheduler({
      submitFrame: () => false,
      requestAnimationFrame: raf.request,
      cancelAnimationFrame: raf.cancel,
    });
    scheduler.requestRender();
    raf.flush();
    expect(scheduler.submittedFrames).toBe(0);
    expect(scheduler.skippedFrames).toBe(1);
  });
});

class FakeAnimationFrames {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextHandle = 1;

  readonly request = (callback: FrameRequestCallback): number => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#callbacks.set(handle, callback);
    return handle;
  };

  readonly cancel = (handle: number): void => {
    this.#callbacks.delete(handle);
  };

  get pending(): number {
    return this.#callbacks.size;
  }

  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback(0);
    }
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}
