import { afterEach, describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type { Forge3DMessageHandler } from "../../src-ts/index.js";
import {
  BoundedAsyncQueue,
  BrowserStagingRing,
  BrowserTileCache,
  Forge3DWorkerPool,
  PromiseFence,
  mipLevelCount,
  selectTextureTranscodeFallback,
  selectWorkerExecutionMode,
  textureByteSize,
  textureFormatInfo,
} from "../../src-ts/browser-resources.js";
import { serveForge3DMessagePort } from "../../src-ts/message-protocol.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectWorkerExecutionMode", () => {
  it("requires worker, isolation, SAB, and preference for SAB mode", () => {
    expect(
      selectWorkerExecutionMode({
        workerAvailable: true,
        crossOriginIsolated: true,
        sharedArrayBufferAvailable: true,
        preferSharedArrayBuffer: true,
      }),
    ).toBe("shared-array-buffer");
    expect(
      selectWorkerExecutionMode({
        workerAvailable: true,
        crossOriginIsolated: true,
        sharedArrayBufferAvailable: true,
      }),
    ).toBe("transferable");
    expect(
      selectWorkerExecutionMode({
        workerAvailable: true,
        crossOriginIsolated: false,
        sharedArrayBufferAvailable: true,
        preferSharedArrayBuffer: true,
      }),
    ).toBe("transferable");
    expect(
      selectWorkerExecutionMode({ workerAvailable: false }),
    ).toBe("main-thread");
  });
});

describe("Forge3DWorkerPool", () => {
  it("falls back to deterministic main-thread execution without a factory", async () => {
    const seen: Array<{ payload: unknown; requestId: number }> = [];
    const pool = new Forge3DWorkerPool({
      size: 4,
      mainThreadHandler: (payload, context) => {
        seen.push({ payload, requestId: context.requestId });
        return (payload as number) * 2;
      },
    });
    expect(pool.getDiagnostics()).toMatchObject({
      mode: "main-thread",
      size: 1,
    });
    expect(await pool.run(21)).toBe(42);
    expect(seen[0]!.requestId).toBe(0);
    pool.dispose();
  });

  it("round-robins across worker ports", async () => {
    const usedBy = new Map<number, number[]>();
    const channels: MessageChannel[] = [];
    const disposers: Array<() => void> = [];
    const pool = new Forge3DWorkerPool({
      size: 2,
      workerFactory: (index) => {
        const channel = new MessageChannel();
        channels.push(channel);
        disposers.push(
          serveForge3DMessagePort(channel.port2, {
            run: (payload) => {
              const list = usedBy.get(index) ?? [];
              list.push(payload as number);
              usedBy.set(index, list);
              return payload;
            },
          }),
        );
        return channel.port1;
      },
      mainThreadHandler: () => {
        throw new Error("must not run on main");
      },
    });
    expect(pool.getDiagnostics().size).toBe(2);
    await Promise.all([pool.run(1), pool.run(2), pool.run(3), pool.run(4)]);
    expect(usedBy.get(0)).toEqual([1, 3]);
    expect(usedBy.get(1)).toEqual([2, 4]);
    pool.dispose();
    for (const dispose of disposers) {
      dispose();
    }
  });

  it("queues FIFO and rejects excess with RESOURCE_LIMIT_EXCEEDED", async () => {
    const order: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = new Forge3DWorkerPool({
      maxQueued: 2,
      mainThreadHandler: async (payload) => {
        order.push(payload as number);
        await gate;
        return payload;
      },
    });
    const first = pool.run(1);
    const second = pool.run(2);
    const third = pool.run(3);
    await expect(pool.run(4)).rejects.toMatchObject({
      code: "RESOURCE_LIMIT_EXCEEDED",
    });
    expect(pool.getDiagnostics().queued).toBe(2);
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
    pool.dispose();
  });

  it("cancels queued work without running it", async () => {
    const ran: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = new Forge3DWorkerPool({
      mainThreadHandler: async (payload) => {
        ran.push(payload as number);
        await gate;
      },
    });
    const first = pool.run(1);
    await tick();
    const controller = new AbortController();
    const second = pool.run(2, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    release();
    await first;
    expect(ran).toEqual([1]);
    pool.dispose();
  });

  it("aborts active main-thread work through the context signal", async () => {
    let aborted = false;
    const pool = new Forge3DWorkerPool({
      mainThreadHandler: (_payload, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve("late");
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();
    const pending = pool.run("x", { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    expect(aborted).toBe(true);
    pool.dispose();
  });

  it("rejects a caller immediately when a never-settling handler is aborted", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const pool = new Forge3DWorkerPool({
      mainThreadHandler: () => {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const controller = new AbortController();
    const first = pool.run(1, { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(first).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    const second = pool.run(2);
    await tick();
    expect(pool.getDiagnostics().active).toBe(1);
    expect(pool.getDiagnostics().queued).toBe(1);
    release();
    await expect(second).resolves.toBeUndefined();
    pool.dispose();
  });

  it("rejects active work on dispose even if the handler never settles", async () => {
    const pool = new Forge3DWorkerPool({
      mainThreadHandler: () => new Promise(() => {}),
    });
    const pending = pool.run(1);
    await tick();
    pool.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });

  it("sends SharedArrayBuffer-backed payloads in shared-array-buffer mode", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const received: unknown[] = [];
    const channel = new MessageChannel();
    const stop = serveForge3DMessagePort(channel.port2, {
      run: (payload) => {
        received.push(payload);
        return true;
      },
    });
    const pool = new Forge3DWorkerPool({
      size: 1,
      preferSharedArrayBuffer: true,
      workerFactory: () => channel.port1,
      mainThreadHandler: () => {
        throw new Error("must not run on main");
      },
    });
    expect(pool.getDiagnostics().mode).toBe("shared-array-buffer");
    const source = new Float32Array([1, 2, 3]);
    const extra = new Uint8Array([9]);
    const payload: Record<string, unknown> = { data: source, extra };
    payload.self = payload;
    await pool.run(payload, {
      transfer: [source.buffer, extra.buffer],
    });
    const result = received[0] as {
      data: Float32Array;
      extra: Uint8Array;
      self: unknown;
    };
    expect(result.data.buffer instanceof SharedArrayBuffer).toBe(true);
    expect(result.extra.buffer instanceof SharedArrayBuffer).toBe(true);
    expect(Array.from(result.data)).toEqual([1, 2, 3]);
    expect(result.self).toBe(result);
    expect(source.buffer.byteLength).toBe(12);
    expect(extra.buffer.byteLength).toBe(1);
    pool.dispose();
    stop();
  });

  it("transfers owned ArrayBuffers in transferable mode", async () => {
    const received: unknown[] = [];
    const channel = new MessageChannel();
    const stop = serveForge3DMessagePort(channel.port2, {
      run: (payload) => {
        received.push(payload);
        return true;
      },
    });
    const pool = new Forge3DWorkerPool({
      size: 1,
      workerFactory: () => channel.port1,
      mainThreadHandler: () => {
        throw new Error("must not run on main");
      },
    });
    expect(pool.getDiagnostics().mode).toBe("transferable");
    const source = new Float32Array([4, 5]);
    await pool.run({ data: source }, { transfer: [source.buffer] });
    const result = (received[0] as { data: Float32Array }).data;
    expect(result.buffer instanceof SharedArrayBuffer).toBe(false);
    expect(Array.from(result)).toEqual([4, 5]);
    expect(source.buffer.byteLength).toBe(0);
    pool.dispose();
    stop();
  });

  it("dispose rejects queued and future work", async () => {
    const handler: Forge3DMessageHandler = () => new Promise(() => {});
    const pool = new Forge3DWorkerPool({ mainThreadHandler: handler });
    const active = pool.run(1);
    const queued = pool.run(2);
    pool.dispose();
    await expect(queued).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
    await expect(pool.run(3)).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
    expect(pool.getDiagnostics().disposed).toBe(true);
    active.catch(() => undefined);
    pool.dispose();
  });
});

describe("PromiseFence", () => {
  it("resolves waiters when their fence completes", async () => {
    const fence = new PromiseFence();
    const pending = fence.wait(3);
    fence.complete(2);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);
    fence.complete(3);
    await tick();
    expect(resolved).toBe(true);
    expect(fence.completed).toBe(3);
    await fence.wait(3);
    fence.dispose();
    await expect(fence.wait(4)).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
});

describe("BrowserStagingRing", () => {
  it("validates rings, sizes, alignment, and stalls when full", () => {
    expect(() => new BrowserStagingRing(0, 64)).toThrowError(Forge3DError);
    const ring = new BrowserStagingRing(2, 64);
    expect(() => ring.allocate(0, 1, 0)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => ring.allocate(4, 3, 0)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => ring.allocate(65, 1, 0)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );

    const first = ring.allocate(32, 16, 0);
    expect(first).toEqual({ ringIndex: 0, offset: 0, size: 32 });
    const second = ring.allocate(16, 8, 0);
    expect(second).toEqual({ ringIndex: 0, offset: 32, size: 16 });
    ring.submitCurrent(1);

    const third = ring.allocate(64, 1, 0);
    expect(third.ringIndex).toBe(1);
    ring.submitCurrent(2);

    expect(() => ring.allocate(1, 1, 0)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(ring.stats().stalls).toBe(1);
    expect(ring.stats().bytesInFlight).toBe(112);

    const fourth = ring.allocate(8, 8, 2);
    expect(fourth.ringIndex).toBe(0);
    expect(ring.stats().bytesInFlight).toBe(0);
  });

  it("rejects negative and non-monotonic fence values", () => {
    const ring = new BrowserStagingRing(2, 64);
    expect(() => ring.allocate(8, 8, -1)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => ring.submitCurrent(-1)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => ring.complete(-1)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    ring.allocate(8, 8, 0);
    ring.submitCurrent(5);
    expect(() => ring.submitCurrent(5)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => ring.submitCurrent(4)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    ring.allocate(8, 8, 0);
    ring.submitCurrent(6);
    expect(ring.stats().bytesInFlight).toBe(16);
  });
});

describe("BoundedAsyncQueue", () => {
  it("is FIFO, bounded, cancellable, and disposable", async () => {
    const queue = new BoundedAsyncQueue<number>(2);
    queue.push(1);
    queue.push(2);
    expect(() => queue.push(3)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(await queue.take()).toBe(1);
    expect(await queue.take()).toBe(2);

    const controller = new AbortController();
    const waiting = queue.take({ signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });

    const handed = queue.take();
    queue.push(9);
    expect(await handed).toBe(9);

    const pending = queue.take();
    queue.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
    await expect(queue.take()).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
});

describe("BrowserTileCache", () => {
  it("evicts least recently used entries within a byte budget", () => {
    const cache = new BrowserTileCache<string>(10);
    cache.insert("a", "A", 4);
    cache.insert("b", "B", 4);
    cache.insert("c", "C", 4);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    cache.insert("d", "D", 4);
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("d")).toBe("D");
    expect(cache.stats()).toEqual({
      entryCount: 2,
      bytesUsed: 8,
      budgetBytes: 10,
    });
    expect(() => cache.insert("huge", "H", 11)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(cache.remove("b")).toBe(true);
    expect(cache.remove("b")).toBe(false);
    cache.clear();
    expect(cache.stats().bytesUsed).toBe(0);
  });
});

describe("texture helpers", () => {
  it("computes mip chains and byte sizes for plain and block formats", () => {
    expect(mipLevelCount(256, 256)).toBe(9);
    expect(mipLevelCount(4, 2)).toBe(3);
    expect(textureByteSize("rgba8unorm", 4, 4, 1)).toBe(64);
    expect(textureByteSize("rgba8unorm", 4, 4, 3)).toBe(64 + 16 + 4);
    expect(textureByteSize("bc1-rgba-unorm", 8, 8, 1)).toBe(32);
    expect(textureByteSize("bc3-rgba-unorm", 8, 8, 1)).toBe(64);
    expect(textureByteSize("etc2-rgb8unorm", 5, 5, 1)).toBe(32);
    expect(() => textureByteSize("rgba8unorm", 4, 4, 4)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => textureByteSize("astc-4x4", 4, 4, 1)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(textureFormatInfo("bc7-rgba-unorm")).toMatchObject({
      bytesPerBlock: 16,
      compressed: true,
    });
    expect(textureFormatInfo("nope")).toBeUndefined();
  });

  it("computes mip sizes above the 32-bit shift range", () => {
    expect(textureByteSize("rgba8unorm", 2 ** 32, 1, 1)).toBe(2 ** 32 * 4);
    expect(textureByteSize("rgba8unorm", 2 ** 32, 2, 2)).toBe(
      2 ** 32 * 2 * 4 + 2 ** 31 * 4,
    );
    expect(mipLevelCount(2 ** 32, 1)).toBe(33);
  });

  it("selects BC7 then ETC2 then RGBA8 fallbacks", () => {
    expect(
      selectTextureTranscodeFallback(
        ["bc7-rgba-unorm", "rgba8unorm"],
        false,
      ),
    ).toBe("bc7-rgba-unorm");
    expect(
      selectTextureTranscodeFallback(
        ["etc2-rgba8unorm", "rgba8unorm"],
        false,
      ),
    ).toBe("etc2-rgba8unorm");
    expect(
      selectTextureTranscodeFallback(["rgba8unorm-srgb"], true),
    ).toBe("rgba8unorm-srgb");
    expect(selectTextureTranscodeFallback([], false)).toBeUndefined();
  });
});
