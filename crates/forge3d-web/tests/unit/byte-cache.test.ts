// W08 (F2/F5): byte caches — MemoryByteCache LRU + budgets,
// DigestCheckedByteCache checksum framing over injectable stores,
// persistent adapter factories and the backend-selection factory.

import { describe, expect, it, vi } from "vitest";

import {
  cacheStorageByteStore,
  CacheStorageByteCache,
  createPersistentByteCache,
  DigestCheckedByteCache,
  IndexedDbByteCache,
  indexedDbByteStore,
  MemoryByteCache,
  OpfsByteCache,
  opfsByteStore,
  type PersistentByteStore,
} from "../../src-ts/index.js";

function mapStore(): PersistentByteStore & { entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
    clear: async () => entries.clear(),
  };
}

describe("MemoryByteCache", () => {
  it("validates the budget", () => {
    expect(() => new MemoryByteCache(0)).toThrowError(/budgetBytes/);
    expect(() => new MemoryByteCache(-1)).toThrowError(/budgetBytes/);
    expect(() => new MemoryByteCache(1.5)).toThrowError(/budgetBytes/);
  });

  it("hits, misses, and overwrites entries", () => {
    const cache = new MemoryByteCache(64);
    cache.put("a", new Uint8Array(8));
    cache.put("a", new Uint8Array(12));
    expect(cache.get("a")!.byteLength).toBe(12);
    const stats = cache.stats();
    expect(stats.bytes).toBe(12);
    expect(stats.entries).toBe(1);
    expect(stats.hits).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("evicts least-recently-used entries over budget", () => {
    const cache = new MemoryByteCache(24);
    cache.put("a", new Uint8Array(10));
    cache.put("b", new Uint8Array(10));
    // Touch "a" so "b" becomes the LRU victim.
    expect(cache.get("a")).toBeDefined();
    cache.put("c", new Uint8Array(10));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    const stats = cache.stats();
    expect(stats.evictions).toBe(1);
    expect(stats.bytes).toBeLessThanOrEqual(24);
  });

  it("drops an oversized entry entirely", () => {
    const cache = new MemoryByteCache(8);
    cache.put("big", new Uint8Array(16));
    expect(cache.get("big")).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });

  it("deletes and clears", () => {
    const cache = new MemoryByteCache(64);
    cache.put("a", new Uint8Array(4));
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    cache.put("b", new Uint8Array(4));
    cache.clear();
    expect(cache.stats().entries).toBe(0);
  });
});

describe("DigestCheckedByteCache", () => {
  it("round-trips bytes through the framed store", async () => {
    const store = mapStore();
    const cache = new DigestCheckedByteCache("test", store);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.put("k", payload);
    // Framing: 32-byte SHA-256 prefix followed by data.
    const stored = store.entries.get("k")!;
    expect(stored.byteLength).toBe(32 + payload.byteLength);
    const served = await cache.get("k");
    expect(Array.from(served!)).toEqual(Array.from(payload));
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.checksumFailures).toBe(0);
  });

  it("detects corrupted bytes, deletes the entry, and counts a miss", async () => {
    const store = mapStore();
    const cache = new DigestCheckedByteCache("test", store);
    await cache.put("k", new Uint8Array([9, 9, 9]));
    const stored = store.entries.get("k")!;
    stored[stored.byteLength - 1] ^= 0xff; // corrupt the data tail
    expect(await cache.get("k")).toBeUndefined();
    expect(store.entries.has("k")).toBe(false);
    const stats = cache.stats();
    expect(stats.checksumFailures).toBe(1);
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });

  it("detects a truncated frame", async () => {
    const store = mapStore();
    const cache = new DigestCheckedByteCache("test", store);
    await cache.put("k", new Uint8Array([1]));
    store.entries.set("k", store.entries.get("k")!.slice(0, 8));
    expect(await cache.get("k")).toBeUndefined();
    expect(cache.stats().checksumFailures).toBe(1);
  });

  it("isolates entries by key (validators change the key)", async () => {
    const store = mapStore();
    const cache = new DigestCheckedByteCache("test", store);
    await cache.put("k|etag:v1", new Uint8Array([1]));
    await cache.put("k|etag:v2", new Uint8Array([2]));
    expect((await cache.get("k|etag:v1"))![0]).toBe(1);
    expect((await cache.get("k|etag:v2"))![0]).toBe(2);
    await cache.delete("k|etag:v1");
    expect(await cache.get("k|etag:v1")).toBeUndefined();
    expect(await cache.get("k|etag:v2")).toBeDefined();
  });
});

describe("persistent adapters", () => {
  it("adapter classes work over injected stores", async () => {
    for (const Adapter of [
      OpfsByteCache,
      IndexedDbByteCache,
      CacheStorageByteCache,
    ] as const) {
      const cache = new Adapter({ name: "w08", store: mapStore() });
      expect(cache.kind.length).toBeGreaterThan(0);
      await cache.put("tile", new Uint8Array([7, 8]));
      expect(Array.from((await cache.get("tile"))!)).toEqual([7, 8]);
      const stats = cache.stats();
      expect(stats.entries).toBe(1);
      expect(stats.bytes).toBe(2);
    }
  });

  it("opfsByteStore maps keys to namespaced files", async () => {
    // Fake OPFS: directory -> files, writable captures bytes.
    const files = new Map<string, Uint8Array>();
    const makeFile = (name: string) => ({
      getFile: async () => {
        const data = files.get(name);
        if (data === undefined) throw new Error("not found");
        return { arrayBuffer: async () => data.buffer.slice(0) as ArrayBuffer };
      },
      createWritable: async () => ({
        write: async (value: Uint8Array) => {
          files.set(name, value);
        },
        close: async () => {},
      }),
    });
    const namespaceDir = {
      getFileHandle: async (name: string, _options?: { create?: boolean }) => {
        if (!files.has(name)) {
          files.set(name, new Uint8Array(0));
          files.delete(name);
        }
        return makeFile(name);
      },
      getDirectoryHandle: async () => namespaceDir,
      removeEntry: async (name: string) => {
        files.delete(name);
      },
    };
    const root = {
      getDirectoryHandle: async (_name: string, _options?: { create?: boolean }) =>
        namespaceDir,
      getFileHandle: async () => makeFile("x"),
    };
    const store = opfsByteStore("w08-test");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => root },
    });
    try {
      await store.put("forge3d:r:u|v|0:16", new Uint8Array([1, 2]));
      const served = await store.get("forge3d:r:u|v|0:16");
      expect(Array.from(served!)).toEqual([1, 2]);
      // Encoded filename landed in the fake filesystem.
      expect([...files.keys()][0]).not.toContain("|");
      await store.delete("forge3d:r:u|v|0:16");
      expect(await store.get("forge3d:r:u|v|0:16")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("indexedDbByteStore runs over a fake indexedDB factory", async () => {
    const rows = new Map<string, unknown>();
    const objectStore = {
      get: (key: string) => {
        const request = { result: rows.get(key), error: null } as {
          result: unknown;
          error: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        };
        queueMicrotask(() => request.onsuccess?.({}));
        return request;
      },
      put: (value: unknown, key: string) => {
        rows.set(key, value);
        const request = { result: undefined, error: null } as {
          result: unknown;
          error: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        };
        queueMicrotask(() => request.onsuccess?.({}));
        return request;
      },
      delete: (key: string) => {
        rows.delete(key);
        const request = { result: undefined, error: null } as {
          result: unknown;
          error: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        };
        queueMicrotask(() => request.onsuccess?.({}));
        return request;
      },
      clear: () => {
        rows.clear();
        const request = { result: undefined, error: null } as {
          result: unknown;
          error: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        };
        queueMicrotask(() => request.onsuccess?.({}));
        return request;
      },
    };
    const db = {
      objectStoreNames: { contains: () => false },
      createObjectStore: () => objectStore,
      transaction: () => ({ objectStore: () => objectStore }),
      close: () => {},
    };
    const originalIdb = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        const request = { result: db, error: null } as {
          result: typeof db;
          error: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          onupgradeneeded: (() => void) | null;
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.({});
          request.onsuccess?.({});
        });
        return request;
      },
    };
    try {
      const store = indexedDbByteStore("w08-test");
      await store.put("a", new Uint8Array([3, 4]));
      expect(Array.from((await store.get("a"))!)).toEqual([3, 4]);
      await store.delete("a");
      expect(await store.get("a")).toBeUndefined();
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = originalIdb;
    }
  });

  it("cacheStorageByteStore runs over a fake CacheStorage", async () => {
    const entries = new Map<string, Uint8Array>();
    const cache = {
      match: async (request: unknown) => {
        const data = entries.get(String(request));
        if (data === undefined) return undefined;
        return { arrayBuffer: async () => data.buffer.slice(0) as ArrayBuffer };
      },
      put: async (request: unknown, response: unknown) => {
        const body = await (
          response as { arrayBuffer(): Promise<ArrayBuffer> }
        ).arrayBuffer();
        entries.set(String(request), new Uint8Array(body));
      },
      delete: async (request: unknown) => entries.delete(String(request)),
      keys: async () => [...entries.keys()],
    };
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = {
      open: async () => cache,
    };
    try {
      const store = cacheStorageByteStore("w08-test");
      await store.put("a", new Uint8Array([5, 6]));
      expect(Array.from((await store.get("a"))!)).toEqual([5, 6]);
      await store.clear();
      expect(await store.get("a")).toBeUndefined();
    } finally {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });
});

describe("createPersistentByteCache", () => {
  it("returns the first working backend in prefer order", async () => {
    const working = mapStore();
    const cache = await createPersistentByteCache({
      name: "w08",
      prefer: ["cache-storage"],
      stores: { "cache-storage": working },
    });
    expect(cache).not.toBeNull();
    expect(cache!.kind).toBe("cache-storage");
  });

  it("skips failing backends", async () => {
    const broken: PersistentByteStore = {
      get: async () => {
        throw new Error("down");
      },
      put: async () => {
        throw new Error("down");
      },
      delete: async () => {},
      clear: async () => {},
    };
    const cache = await createPersistentByteCache({
      name: "w08",
      prefer: ["opfs", "indexeddb"],
      stores: { opfs: broken, indexeddb: mapStore() },
    });
    expect(cache!.kind).toBe("indexeddb");
  });

  it("returns null when every backend fails", async () => {
    const broken: PersistentByteStore = {
      get: async () => {
        throw new Error("down");
      },
      put: async () => {
        throw new Error("down");
      },
      delete: async () => {},
      clear: async () => {},
    };
    const cache = await createPersistentByteCache({
      name: "w08",
      prefer: ["opfs", "indexeddb", "cache-storage"],
      stores: { opfs: broken, indexeddb: broken, "cache-storage": broken },
    });
    expect(cache).toBeNull();
  });
});
