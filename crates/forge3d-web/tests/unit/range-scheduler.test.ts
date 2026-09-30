// W08 (F1/F5): RangeScheduler unit tests — dedupe, coalescing,
// priority, concurrency, cancellation, range enforcement, offline
// persistent serving, and statistics, all through a mocked 206
// range-serving fetch.

import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type { PersistentByteCache } from "../../src-ts/index.js";
import { MemoryByteCache } from "../../src-ts/byte-cache.js";
import {
  RangeScheduler,
  type RangeFetchLike,
} from "../../src-ts/range-scheduler.js";

function makeBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = i % 251;
  return out;
}

function rangeResponse(
  data: Uint8Array,
  start: number,
  end: number,
  total: number,
): Response {
  return new Response(data.slice(start, end + 1), {
    status: 206,
    headers: {
      "content-range": `bytes ${start}-${end}/${total}`,
      etag: '"v1"',
    },
  });
}

interface RecordedCall {
  range: string;
  signal: AbortSignal;
  resolve: (data: Uint8Array, start: number, end: number) => void;
  reject: (error: unknown) => void;
}

/** Deferred range fetch: each call is finished explicitly by the test. */
function controlledFetch(total = 4096): {
  fetch: RangeFetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: RangeFetchLike = (_input, init) => {
    const record = {} as RecordedCall;
    const promise = new Promise<Response>((resolve, reject) => {
      record.resolve = (data: Uint8Array, start: number, end: number) =>
        resolve(rangeResponse(data, start, end, total));
      record.reject = reject;
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
    record.range = init.headers.Range;
    record.signal = init.signal;
    calls.push(record);
    return promise;
  };
  return { fetch, calls };
}

/** Immediate 206-serving fetch over a byte blob. */
function servingFetch(data: Uint8Array): {
  fetch: RangeFetchLike;
  ranges: string[];
} {
  const ranges: string[] = [];
  const fetch: RangeFetchLike = async (_input, init) => {
    ranges.push(init.headers.Range);
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(match![1]);
    const end = Math.min(Number(match![2]), data.length - 1);
    return rangeResponse(data, start, end, data.length);
  };
  return { fetch, ranges };
}

/** In-memory `PersistentByteCache` whose `get` can be scripted. */
function stubPersistent(behavior?: {
  get?: (key: string, callIndex: number) => Uint8Array | undefined;
}): {
  cache: PersistentByteCache;
  puts: Map<string, Uint8Array>;
  getCalls: number;
} {
  const puts = new Map<string, Uint8Array>();
  const state = { getCalls: 0 };
  const cache: PersistentByteCache = {
    kind: "stub",
    get: async (key) => {
      state.getCalls += 1;
      if (behavior?.get !== undefined) {
        return behavior.get(key, state.getCalls);
      }
      return puts.get(key);
    },
    put: async (key, bytes) => {
      puts.set(key, bytes);
    },
    delete: async (key) => {
      puts.delete(key);
    },
    clear: async () => puts.clear(),
    stats: () => ({
      hits: 0,
      misses: 0,
      checksumFailures: 0,
      entries: puts.size,
      bytes: 0,
    }),
  };
  return { cache, puts, get getCalls() { return state.getCalls; } };
}

const URL_A = "https://example.test/a.bin";
const URL_B = "https://example.test/b.bin";

/** `request()` awaits the validator + persistent lookups before
 * dispatching; several microtask hops are needed for a fetch to land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("RangeScheduler", () => {
  it("rejects invalid offsets, lengths, and options", async () => {
    const scheduler = new RangeScheduler({ fetch: async () => new Response() });
    await expect(scheduler.request(URL_A, -1, 4)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(scheduler.request(URL_A, 0, 0)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(() => new RangeScheduler({ maxConcurrent: 0 })).toThrow(
      Forge3DError,
    );
  });

  it("deduplicates identical ranges onto one HTTP request", async () => {
    const data = makeBytes(64);
    const { fetch, ranges } = servingFetch(data);
    const scheduler = new RangeScheduler({ fetch });
    const [a, b] = await Promise.all([
      scheduler.request(URL_A, 0, 16),
      scheduler.request(URL_A, 0, 16),
    ]);
    expect(Array.from(a)).toEqual(Array.from(data.slice(0, 16)));
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(ranges).toHaveLength(1);
    const stats = scheduler.stats();
    expect(stats.deduplicated).toBe(1);
    expect(stats.httpRequests).toBe(1);
  });

  it("serves a second identical request from the memory cache", async () => {
    const data = makeBytes(64);
    const { fetch, ranges } = servingFetch(data);
    const scheduler = new RangeScheduler({
      fetch,
      memoryCache: new MemoryByteCache(1024),
    });
    await scheduler.request(URL_A, 0, 16);
    const cached = await scheduler.request(URL_A, 0, 16);
    expect(Array.from(cached)).toEqual(Array.from(data.slice(0, 16)));
    expect(ranges).toHaveLength(1);
    expect(scheduler.stats().httpRequests).toBe(1);
  });

  it("coalesces queued ranges within the gap into one HTTP request", async () => {
    const data = makeBytes(4096);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({
      fetch,
      maxConcurrent: 1,
      coalesceGapBytes: 16,
    });
    const first = scheduler.request(URL_A, 0, 16);
    const second = scheduler.request(URL_A, 32, 16);
    const third = scheduler.request(URL_A, 64, 16);
    await flush();
    expect(calls).toHaveLength(1);
    // Finish the in-flight request; the queued pair merges [32,80).
    calls[0]!.resolve(data, 0, 15);
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.range).toBe("bytes=32-79");
    calls[1]!.resolve(data, 32, 79);
    const [b, c] = await Promise.all([second, third]);
    expect(Array.from(b)).toEqual(Array.from(data.slice(32, 48)));
    expect(Array.from(c)).toEqual(Array.from(data.slice(64, 80)));
    expect(scheduler.stats().coalesced).toBe(1);
    expect(scheduler.stats().httpRequests).toBe(2);
  });

  it("dispatches the highest-priority queued request first", async () => {
    const data = makeBytes(1024);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({ fetch, maxConcurrent: 1 });
    const first = scheduler.request(URL_A, 0, 16);
    const low = scheduler.request(URL_A, 100, 16, { priority: 10 });
    const high = scheduler.request(URL_B, 200, 16, { priority: -5 });
    const mid = scheduler.request(URL_A, 300, 16, { priority: 0 });
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(data, 0, 15);
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    // Different-source URL_B cannot coalesce with URL_A entries; it is
    // dispatched first because its priority (-5) is smallest.
    expect(calls[1]!.range).toBe("bytes=200-215");
    calls[1]!.resolve(data, 200, 215);
    await high;
    await flush();
    expect(calls).toHaveLength(3);
    // mid (offset 300) coalesces with low (offset 100): merged [100,316).
    expect(calls[2]!.range).toBe("bytes=100-315");
    calls[2]!.resolve(data, 100, 315);
    await Promise.all([low, mid]);
  });

  it("bounds concurrency and reports peak in-flight", async () => {
    const data = makeBytes(1024);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({ fetch, maxConcurrent: 2 });
    const pending = [
      scheduler.request(URL_A, 0, 8),
      scheduler.request(URL_B, 16, 8),
      scheduler.request("https://example.test/c.bin", 24, 8),
      scheduler.request("https://example.test/d.bin", 32, 8),
    ];
    await flush();
    expect(calls).toHaveLength(2);
    expect(scheduler.stats().inFlight).toBe(2);
    expect(scheduler.stats().queued).toBe(2);
    calls[0]!.resolve(data, 0, 7);
    await pending[0];
    await flush();
    expect(calls).toHaveLength(3);
    // Resolving a unit dispatches the next queued request on a
    // microtask continuation — flush between resolutions.
    // Answer each call with the range it asked for.
    const starts = [0, 16, 24, 32];
    for (let i = 1; i < 4; i += 1) {
      calls[i]!.resolve(data, starts[i]!, starts[i]! + 7);
      await flush();
    }
    await Promise.all(pending.slice(1));
    const stats = scheduler.stats();
    expect(stats.peakInFlight).toBe(2);
    expect(stats.httpRequests).toBe(4);
  });

  it("cancels a queued request without fetching it", async () => {
    const data = makeBytes(1024);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({ fetch, maxConcurrent: 1 });
    const controller = new AbortController();
    const first = scheduler.request(URL_A, 0, 16);
    const cancelled = scheduler.request(URL_B, 32, 16, {
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    calls[0]!.resolve(data, 0, 15);
    await first;
    expect(calls).toHaveLength(1);
    expect(scheduler.stats().cancelled).toBe(1);
  });

  it("aborts the underlying fetch when the last subscriber cancels", async () => {
    const { fetch, calls } = controlledFetch(1024);
    const scheduler = new RangeScheduler({ fetch });
    const controller = new AbortController();
    const pending = scheduler.request(URL_A, 0, 16, {
      signal: controller.signal,
    });
    await flush();
    expect(calls).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it("rejects pre-aborted signals immediately", async () => {
    const scheduler = new RangeScheduler({ fetch: async () => new Response() });
    const controller = new AbortController();
    controller.abort();
    await expect(
      scheduler.request(URL_A, 0, 16, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(scheduler.stats().httpRequests).toBe(0);
  });

  it("fails fast when the server ignores Range (200)", async () => {
    const signals: AbortSignal[] = [];
    const fetch: RangeFetchLike = async (_input, init) => {
      signals.push(init.signal);
      return new Response(makeBytes(4096), { status: 200 });
    };
    const scheduler = new RangeScheduler({ fetch });
    await expect(scheduler.request(URL_A, 0, 16)).rejects.toMatchObject({
      code: "IO_ERROR",
      details: { reason: "range-not-supported" },
    });
    // The body is never consumed: bounded transfer for range-ignoring
    // servers.
    expect(scheduler.stats().bytesTransferred).toBe(0);
    // The underlying fetch is aborted so the browser stops downloading the
    // full-file body instead of transferring it to nowhere.
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("maps HTTP 416 to a not-satisfiable IO error", async () => {
    const fetch: RangeFetchLike = async () =>
      new Response(null, { status: 416 });
    const scheduler = new RangeScheduler({ fetch });
    await expect(scheduler.request(URL_A, 1 << 30, 16)).rejects.toMatchObject({
      code: "IO_ERROR",
      details: { reason: "range-not-satisfiable" },
    });
  });

  it("fails on short non-EOF responses", async () => {
    const fetch: RangeFetchLike = async () =>
      new Response(makeBytes(4), {
        status: 206,
        headers: {
          "content-range": "bytes 0-15/4096",
          etag: '"v1"',
        },
      });
    const scheduler = new RangeScheduler({ fetch });
    await expect(scheduler.request(URL_A, 0, 16)).rejects.toMatchObject({
      code: "IO_ERROR",
      details: { expected: 16, received: 4 },
    });
  });

  it("serves persistent hits without any HTTP request", async () => {
    const bytes = makeBytes(16);
    const { cache } = stubPersistent({ get: () => bytes });
    const fetch: RangeFetchLike = async () => {
      throw new Error("must not be called");
    };
    const scheduler = new RangeScheduler({ fetch, persistentCache: cache });
    const served = await scheduler.request(URL_A, 0, 16);
    expect(Array.from(served)).toEqual(Array.from(bytes));
    const stats = scheduler.stats();
    expect(stats.persistentHits).toBe(1);
    expect(stats.httpRequests).toBe(0);
  });

  it("reads Blob sources locally without fetch", async () => {
    const data = makeBytes(64);
    const fetch: RangeFetchLike = async () => {
      throw new Error("must not be called");
    };
    const scheduler = new RangeScheduler({ fetch });
    const blob = new Blob([data]);
    const out = await scheduler.request(blob, 8, 16);
    expect(Array.from(out)).toEqual(Array.from(data.slice(8, 24)));
    expect(scheduler.stats().httpRequests).toBe(0);
  });

  it("records file sizes from Content-Range totals", async () => {
    const data = makeBytes(2048);
    const { fetch } = servingFetch(data);
    const scheduler = new RangeScheduler({ fetch });
    expect(scheduler.fileSize(URL_A)).toBeUndefined();
    await scheduler.request(URL_A, 0, 16);
    expect(scheduler.fileSize(URL_A)).toBe(2048);
  });

  it("aggregates statistics across the lifecycle", async () => {
    const data = makeBytes(256);
    const { fetch } = servingFetch(data);
    const scheduler = new RangeScheduler({
      fetch,
      memoryCache: new MemoryByteCache(1024),
    });
    await scheduler.request(URL_A, 0, 8);
    await scheduler.request(URL_A, 0, 8);
    await scheduler.request(URL_A, 8, 8);
    expect(scheduler.stats()).toEqual({
      requested: 3,
      deduplicated: 0,
      coalesced: 0,
      httpRequests: 2,
      bytesRequested: 24,
      bytesTransferred: 16,
      memoryHits: 1,
      persistentHits: 0,
      misses: 2,
      cancelled: 0,
      failed: 0,
      inFlight: 0,
      peakInFlight: 1,
      queued: 0,
      offlineServed: 0,
    });
  });

  it("dispose rejects queued and in-flight subscribers", async () => {
    const { fetch, calls } = controlledFetch();
    const scheduler = new RangeScheduler({ fetch, maxConcurrent: 1 });
    const first = scheduler.request(URL_A, 0, 16);
    const second = scheduler.request(URL_B, 32, 16);
    await flush();
    scheduler.dispose();
    await expect(first).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(second).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(calls[0]!.signal.aborted).toBe(true);
    await expect(scheduler.request(URL_A, 0, 8)).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
});

describe("RangeScheduler review fixes", () => {
  it("keeps reverse-order ranges separate beyond the gap and bounds merged size", async () => {
    const data = makeBytes(8192);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({
      fetch,
      maxConcurrent: 1,
      coalesceGapBytes: 16,
      maxCoalescedBytes: 64,
    });
    const blocker = scheduler.request(URL_B, 0, 8);
    // Queued in reverse order, ~1000 bytes apart (far beyond the gap).
    const far = scheduler.request(URL_A, 5000, 16);
    const near = scheduler.request(URL_A, 4000, 16);
    const nearest = scheduler.request(URL_A, 3000, 16);
    await flush();
    calls[0]!.resolve(data, 0, 7);
    await blocker;
    for (let i = 1; i <= 3; i += 1) {
      await flush();
      await flush();
      expect(calls).toHaveLength(i + 1);
      const match = /bytes=(\d+)-(\d+)/.exec(calls[i]!.range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      expect(end - start + 1).toBe(16);
      calls[i]!.resolve(data, start, end);
    }
    await Promise.all([far, near, nearest]);
    expect(scheduler.stats().coalesced).toBe(0);
  });

  it("never lets a reverse-order merge exceed maxCoalescedBytes", async () => {
    const data = makeBytes(8192);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({
      fetch,
      maxConcurrent: 1,
      coalesceGapBytes: 16,
      maxCoalescedBytes: 64,
    });
    const blocker = scheduler.request(URL_B, 0, 8);
    const pending = [80, 64, 48, 32, 16, 0].map((offset) =>
      scheduler.request(URL_A, offset, 16),
    );
    await flush();
    calls[0]!.resolve(data, 0, 7);
    await blocker;
    const sizes: number[] = [];
    let served = 1;
    for (let guard = 0; guard < 10; guard += 1) {
      await flush();
      await flush();
      if (calls.length === served) break;
      const call = calls[served]!;
      served += 1;
      const match = /bytes=(\d+)-(\d+)/.exec(call.range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      sizes.push(end - start + 1);
      call.resolve(data, start, end);
    }
    const results = await Promise.all(pending);
    [80, 64, 48, 32, 16, 0].forEach((offset, i) => {
      expect(Array.from(results[i]!)).toEqual(
        Array.from(data.slice(offset, offset + 16)),
      );
    });
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(96);
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(64);
    }
  });

  it("cancels a subscriber after its range was merged into a coalesced fetch", async () => {
    const data = makeBytes(4096);
    const { fetch, calls } = controlledFetch(data.length);
    const scheduler = new RangeScheduler({
      fetch,
      maxConcurrent: 1,
      coalesceGapBytes: 16,
    });
    const blocker = scheduler.request(URL_B, 0, 8);
    const a = new AbortController();
    const b = new AbortController();
    const first = scheduler.request(URL_A, 0, 16, { signal: a.signal });
    const second = scheduler.request(URL_A, 16, 16, { signal: b.signal });
    await flush();
    calls[0]!.resolve(data, 0, 7);
    await blocker;
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.range).toBe("bytes=0-31");
    a.abort();
    await expect(first).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(scheduler.stats().cancelled).toBe(1);
    expect(calls[1]!.signal.aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(scheduler.stats().cancelled).toBe(2);
    // Every subscriber of the merged fetch cancelled: the fetch is aborted.
    expect(calls[1]!.signal.aborted).toBe(true);
    await flush();
    expect(scheduler.stats().inFlight).toBe(0);
  });

  it("rejects a 206 whose Content-Range is missing or does not match", async () => {
    const cases: Array<[string | null, number]> = [
      [null, 16],
      ["bytes 4-19/4096", 16],
      ["bytes 0-7/4096", 8],
      ["garbage", 16],
    ];
    for (const [contentRange, bodyLength] of cases) {
      const headers: Record<string, string> = { etag: '"v1"' };
      if (contentRange !== null) headers["content-range"] = contentRange;
      const fetch: RangeFetchLike = async () =>
        new Response(makeBytes(bodyLength), { status: 206, headers });
      const scheduler = new RangeScheduler({ fetch });
      await expect(scheduler.request(URL_A, 0, 16)).rejects.toMatchObject({
        code: "IO_ERROR",
        details: { reason: "content-range-mismatch" },
      });
      expect(scheduler.stats().failed).toBe(1);
    }
    // A range that stops at end of file is accepted.
    const eof: RangeFetchLike = async () =>
      new Response(makeBytes(6), {
        status: 206,
        headers: { "content-range": "bytes 10-15/16", etag: '"v1"' },
      });
    const scheduler = new RangeScheduler({ fetch: eof });
    await expect(scheduler.request(URL_A, 10, 16)).resolves.toHaveLength(6);
  });

  it("fails the unit without leaking a slot when the persistent get throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let fail = false;
      const { cache } = stubPersistent({
        get: () => {
          if (fail) throw new Error("storage broken");
          return undefined;
        },
      });
      let call = 0;
      const data = makeBytes(64);
      const fetch: RangeFetchLike = async (_input, init) => {
        call += 1;
        if (call === 1) {
          fail = true;
          throw new Error("network down");
        }
        const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
        return rangeResponse(data, Number(match[1]), Number(match[2]), 64);
      };
      const scheduler = new RangeScheduler({
        fetch,
        maxConcurrent: 1,
        persistentCache: cache,
      });
      await expect(scheduler.request(URL_A, 0, 16)).rejects.toThrow(
        /network down/,
      );
      expect(scheduler.stats().inFlight).toBe(0);
      expect(scheduler.stats().failed).toBe(1);
      // The slot is free: the next request dispatches and resolves.
      const next = await scheduler.request(URL_A, 16, 16);
      expect(Array.from(next)).toEqual(Array.from(data.slice(16, 32)));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("counts failed exactly on every failure path", async () => {
    const responses: Array<() => Response> = [
      () => new Response(makeBytes(64), { status: 200 }),
      () => new Response(null, { status: 416 }),
      () => new Response(null, { status: 500 }),
      () =>
        new Response(makeBytes(4), {
          status: 206,
          headers: { "content-range": "bytes 0-15/4096" },
        }),
    ];
    for (const make of responses) {
      const scheduler = new RangeScheduler({ fetch: async () => make() });
      await expect(scheduler.request(URL_A, 0, 16)).rejects.toMatchObject({
        code: "IO_ERROR",
      });
      expect(scheduler.stats()).toEqual({
        requested: 1,
        deduplicated: 0,
        coalesced: 0,
        httpRequests: 1,
        bytesRequested: 16,
        bytesTransferred: 0,
        memoryHits: 0,
        persistentHits: 0,
        misses: 1,
        cancelled: 0,
        failed: 1,
        inFlight: 0,
        peakInFlight: 1,
        queued: 0,
        offlineServed: 0,
      });
    }
  });

  it("sends If-Match with a known strong ETag and retries once on 412", async () => {
    const data = makeBytes(256);
    const { cache, puts } = stubPersistent();
    const memory = new MemoryByteCache(4096);
    const seen: Array<Record<string, string>> = [];
    let etag = '"v1"';
    const fetch: RangeFetchLike = async (_input, init) => {
      seen.push({ ...init.headers });
      const ifMatch = init.headers["If-Match"];
      if (ifMatch !== undefined && ifMatch !== etag) {
        return new Response(null, { status: 412 });
      }
      const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(data.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/256`, etag },
      });
    };
    const scheduler = new RangeScheduler({
      fetch,
      persistentCache: cache,
      memoryCache: memory,
    });
    await scheduler.request(URL_A, 0, 16);
    expect(seen[0]!["If-Match"]).toBeUndefined();
    const oldKey = [...puts.keys()].find((key) => key.endsWith("|0:16"))!;
    expect(oldKey).toContain('"v1"');
    expect(memory.peek(oldKey)).toBeDefined();
    await scheduler.request(URL_A, 16, 16);
    expect(seen[1]!["If-Match"]).toBe('"v1"');

    etag = '"v2"';
    const fresh = await scheduler.request(URL_A, 32, 16);
    expect(Array.from(fresh)).toEqual(Array.from(data.slice(32, 48)));
    expect(seen[2]!["If-Match"]).toBe('"v1"');
    expect(seen[3]!["If-Match"]).toBeUndefined();
    expect(seen).toHaveLength(4);
    // The stale validator and its cache entries are gone.
    expect(puts.has(oldKey)).toBe(false);
    expect(memory.peek(oldKey)).toBeUndefined();
    expect([...puts.keys()].some((key) => key.includes('"v1"'))).toBe(false);
    expect([...puts.keys()].some((key) => key.includes('"v2"'))).toBe(true);
    expect(scheduler.stats().failed).toBe(0);
  });

  it("drops the validator and retries once on a 200 to a conditional request", async () => {
    const data = makeBytes(64);
    const seen: Array<Record<string, string>> = [];
    let mode: "206" | "200" = "206";
    const fetch: RangeFetchLike = async (_input, init) => {
      seen.push({ ...init.headers });
      if (mode === "200" && init.headers["If-Match"] !== undefined) {
        return new Response(data, { status: 200, headers: { etag: '"v2"' } });
      }
      const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(data.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/64`, etag: '"v2"' },
      });
    };
    const scheduler = new RangeScheduler({ fetch });
    await scheduler.request(URL_A, 0, 8);
    mode = "200";
    await expect(scheduler.request(URL_A, 8, 8)).resolves.toHaveLength(8);
    expect(seen[1]!["If-Match"]).toBe('"v2"');
    expect(seen[2]!["If-Match"]).toBeUndefined();
    expect(scheduler.stats().httpRequests).toBe(3);
  });

  it("never sends If-Match for weak ETags", async () => {
    const data = makeBytes(64);
    const seen: Array<Record<string, string>> = [];
    const fetch: RangeFetchLike = async (_input, init) => {
      seen.push({ ...init.headers });
      const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(data.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/64`, etag: 'W/"w1"' },
      });
    };
    const scheduler = new RangeScheduler({ fetch });
    await scheduler.request(URL_A, 0, 8);
    await scheduler.request(URL_A, 8, 8);
    expect(seen[1]!["If-Match"]).toBeUndefined();
  });

  it("serves bytes another scheduler persisted while this fetch was failing", async () => {
    const data = makeBytes(256);
    const { cache } = stubPersistent();
    const writer = new RangeScheduler({
      fetch: servingFetch(data).fetch,
      persistentCache: cache,
    });
    await writer.request(URL_A, 0, 16);
    const { fetch, calls } = controlledFetch(data.length);
    const reader = new RangeScheduler({ fetch, persistentCache: cache });
    const pending = reader.request(URL_A, 32, 16);
    await flush();
    await flush();
    expect(calls).toHaveLength(1);
    // Another tab/worker sharing the cache fetches the same range.
    await writer.request(URL_A, 32, 16);
    calls[0]!.reject(new TypeError("Failed to fetch"));
    const served = await pending;
    expect(Array.from(served)).toEqual(Array.from(data.slice(32, 48)));
    expect(reader.stats()).toMatchObject({
      offlineServed: 1,
      failed: 1,
      persistentHits: 1,
      httpRequests: 1,
    });
  });
});
