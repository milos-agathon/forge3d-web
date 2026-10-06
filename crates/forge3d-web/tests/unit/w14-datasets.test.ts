import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DatasetRegistry,
  decodeDatasetNpy,
  DATASET_BASE_URL,
} from "../../src-ts/datasets.js";
import { DigestCheckedByteCache } from "../../src-ts/byte-cache.js";
import { VerifiedAssetStore } from "../../src-ts/verified-assets.js";
const read = (file: string) =>
  new Uint8Array(
    readFileSync(new URL("../../assets/datasets/" + file, import.meta.url)),
  );
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function cache() {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    adapter: new DigestCheckedByteCache("test", {
      async get(k) {
        return map.get(k)?.slice();
      },
      async put(k, v) {
        map.set(k, v.slice());
      },
      async delete(k) {
        map.delete(k);
      },
      async clear() {
        map.clear();
      },
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("W14 native datasets and verified storage", () => {
  it("reports persistent backend failures as typed IO errors", async () => {
    const cache:any={async get(){throw Error("Storage access denied");}};
    const registry=new DatasetRegistry({cache,bundledBaseUrl:"https://self.test/"});
    await expect(registry.fetch("mini_dem")).rejects.toMatchObject({code:"IO_ERROR",details:{kind:"asset-io",asset:"mini_dem"}});
    expect(registry.getDiagnostics().activeRequests).toBe(0);registry.dispose();
  });
  it("preserves the complete native registry, kinds, descriptions and known hashes", () => {
    const registry = new DatasetRegistry({
        cache: null,
        bundledBaseUrl: "https://self.test/data/",
      }),
      native = JSON.parse(new TextDecoder().decode(read("provenance.json")));
    expect(registry.bundled()).toEqual(["mini_dem", "sample_boundaries"]);
    expect(registry.remote()).toHaveLength(10);
    for (const n of native.remote) {
      const metadata=registry.info(n.name);
      expect(metadata.nativeSha256 ?? metadata.sha256).toBe(n.known_hash.slice(7));
      expect(metadata).toMatchObject({
        kind: n.kind,
        filename: n.filename,
        description: n.description,
      });
    }
    expect(registry.info("sample-buildings").sha256).toBe("b580f03628a86da237a0c5b9bb023a3893ec72d7422170ab02a48bb150db2f17");
    expect(registry.info("mount-fuji-buildings").sha256).toBe("3e2b88beb62b74517208e93433d7beff6d3017115485be5f5899a80f9e8b9f6e");
    expect(registry.url("sample-buildings").hostname).toBe("raw.githubusercontent.com");
    expect(registry.url("rainier").hostname).toBe("media.githubusercontent.com");
    const info = registry.info("rainier");
    info.sha256 = "changed";
    expect(registry.info("rainier").sha256).not.toBe("changed");
    expect(DATASET_BASE_URL).toContain(
      "media.githubusercontent.com/media/milos-agathon/forge3d/main/",
    );
    expect(() => registry.info("unknown")).toThrow("Unknown dataset");
    expect(registry.url("rainier").href).toContain("tif/dem_rainier.tif");
    expect(registry.info("sample_boundaries")).toMatchObject({
      coordinateSpace: "normalized",
    });
    expect(registry.info("sample_boundaries").crs).toBeUndefined();
    expect(registry.listDatasets()).toHaveLength(12);
    expect(Object.keys(registry.datasetInfo())).toHaveLength(12);
    expect(registry.miniDemUrl().pathname).toMatch(/mini_dem.npy$/);
    expect(registry.sampleBoundariesUrl().pathname).toMatch(
      /sample_boundaries.geojson$/,
    );
  });
  it("loads native DEM and boundaries exactly, with defensive typed buffers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: any) =>
          new Response(read(new URL(url).pathname.split("/").pop()!)),
      ),
    );
    const registry = new DatasetRegistry({
      cache: null,
      bundledBaseUrl: "https://self.test/data/",
    });
    const dem = await registry.miniDem();
    expect(dem).toMatchObject({ width: 256, height: 256 });
    expect(dem.data).toBeInstanceOf(Float32Array);
    expect(Math.max(...dem.data)).toBeGreaterThan(500);
    expect(Math.min(...dem.data)).toBeLessThan(0);
    expect(await registry.sampleBoundaries()).toMatchObject({
      type: "FeatureCollection",
    });
    expect(
      (await registry.sampleBoundaries()).features!.length,
    ).toBeGreaterThanOrEqual(3);
    expect(await registry.fetchCityJson("sample_boundaries")).toEqual(await registry.fetch("sample_boundaries"));
    expect(await registry.fetchCopc("mini_dem")).toEqual(await registry.fetch("mini_dem"));
    dem.data.fill(0);
    expect(Math.max(...(await registry.miniDem()).data)).toBeGreaterThan(500);
    expect(() => decodeDatasetNpy(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => decodeDatasetNpy(read("mini_dem.npy").slice(0, -4))).toThrow();
    await expect(registry.fetchDem("sample-buildings")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    registry.dispose();
    registry.dispose();
    expect(registry.getDiagnostics().memoryBytes).toBe(0);
    await expect(registry.fetch("mini_dem")).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
  it("caches exact bytes across instances, refuses offline misses and corrupted entries", async () => {
    const { adapter, map } = cache();
    const network = vi.fn(async () => new Response(read("mini_dem.npy")));
    vi.stubGlobal("fetch", network);
    const options = { cache: adapter, bundledBaseUrl: "https://self.test/" };
    const first = new DatasetRegistry(options);
    const bytes = await first.fetch("mini_dem");
    first.dispose();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw Error("network forbidden");
      }),
    );
    const offline = new DatasetRegistry(options);
    expect(await offline.fetch("mini_dem", { offline: true })).toEqual(bytes);
    offline.dispose();
    const key = [...map.keys()][0]!;
    const entry = map.get(key)!;
    entry[50] ^= 1;
    await expect(
      new DatasetRegistry(options).fetch("mini_dem", { offline: true }),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    expect(map.size).toBe(0);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("compares cache bytes to the registry digest, not just their stored frame", async () => {
    const { adapter } = cache(),
      registry = new DatasetRegistry({
        cache: adapter,
        bundledBaseUrl: "https://self.test/",
      });
    const meta = registry.info("mini_dem");
    await adapter.put(
      `forge3d:asset:native-1f4084af428dc699bdcd108b029736cb73903926:${meta.sha256}`,
      new Uint8Array([1, 2, 3]),
    );
    await expect(
      registry.fetch("mini_dem", { offline: true }),
    ).rejects.toMatchObject({ details: { kind: "asset-integrity" } });
  });
  it("rejects network tampering, HTTP errors, oversized streams and invalid registry metadata", async () => {
    const registry = new DatasetRegistry({
      cache: null,
      bundledBaseUrl: "https://self.test/",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    await expect(registry.fetch("mini_dem")).rejects.toMatchObject({
      details: { kind: "asset-integrity" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(registry.fetch("mini_dem")).rejects.toMatchObject({
      code: "IO_ERROR",
    });
    await expect(
      new DatasetRegistry({
        cache: null,
        maxAssetBytes: 32,
        bundledBaseUrl: "https://self.test/",
      }).fetch("mini_dem"),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
    expect(() => new DatasetRegistry({ memoryBudgetBytes: 0 })).toThrow();
    const m = registry.info("mini_dem");
    expect(() => new DatasetRegistry({ entries: [m, m] })).toThrow();
    expect(
      () =>
        new DatasetRegistry({ entries: [{ ...m, relativeUrl: "../escape" }] }),
    ).toThrow();
    for (const relativeUrl of [
      "/escape",
      "//evil.test/a",
      "%2e%2e/escape",
      "a\\b",
      "https://evil.test/a",
    ])
      expect(
        () => new DatasetRegistry({ entries: [{ ...m, relativeUrl }] }),
      ).toThrow();
  });
  it("cancels network reads and disposal leaves no active owned request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: any, options: any) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const registry = new DatasetRegistry({
        cache: null,
        bundledBaseUrl: "https://self.test/",
      }),
      controller = new AbortController();
    const fetch = registry.fetch("mini_dem", { signal: controller.signal });
    await vi.waitFor(() =>
      expect(registry.getDiagnostics().activeRequests).toBe(1),
    );
    // Allow the cache probe and request setup to run before cancellation.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(fetch).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(registry.getDiagnostics().activeRequests).toBe(0);
    const next = registry.fetch("mini_dem");
    await new Promise((r) => setTimeout(r, 5));
    registry.dispose();
    await expect(next).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(registry.getDiagnostics()).toMatchObject({
      activeRequests: 0,
      memoryBytes: 0,
      disposed: true,
    });
  });
  it("bounds in-memory caches and reports persistent/cache usage", async () => {
    const { adapter } = cache(),
      bytes = read("sample_boundaries.geojson"),
      store = new VerifiedAssetStore(adapter, 2048, 100);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const value = await store.read({
      name: "bounds",
      url: "https://self.test/",
      sha256: hash(bytes),
      byteLength: bytes.length,
      version: "1",
    });
    expect(value).toEqual(bytes);
    expect(store.memory.stats().bytes).toBe(0);
    expect(adapter.stats().entries).toBe(1);
    store.dispose();
    await expect(
      store.read({
        name: "bounds",
        url: "https://self.test/",
        sha256: hash(bytes),
        version: "1",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
  });
  it("serves each native fetch-kind through the verified browser cache adapter", async () => {
    const native = new DatasetRegistry({ cache: null }),
      bytes = new Uint8Array([1, 2, 3]),
      { adapter } = cache();
    const entries = ["rainier", "sample-buildings", "mt-st-helens"].map(
      (name) => ({
        ...native.info(name),
        sha256: hash(bytes),
        byteLength: 3,
        version: "test-kind-v1",
      }),
    );
    const progress: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const registry = new DatasetRegistry({
      entries,
      cache: adapter,
      baseUrl: "https://self.test/assets/",
    });
    for (const [name, method] of [
      ["rainier", "fetchDem"],
      ["sample-buildings", "fetchCityJson"],
      ["mt-st-helens", "fetchCopc"],
    ] as const) {
      expect(
        await registry[method](name, { onProgress: (p) => progress.push(p) }),
      ).toEqual(bytes);
      expect(await registry[method](name, { offline: true })).toEqual(bytes);
    }
    expect(progress.some((p) => p.done && p.loaded === 3)).toBe(true);
    registry.dispose();
  });
  it("promptly cancels an unresponsive persistent cache and releases the request", async () => {
    const persistent: any = {
      get: () => new Promise(() => {}),
      delete: async () => {},
      put: async () => {},
    };
    const registry = new DatasetRegistry({
        cache: persistent,
        bundledBaseUrl: "https://self.test/",
      }),
      controller = new AbortController();
    const pending = registry.fetch("mini_dem", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(registry.getDiagnostics().activeRequests).toBe(0);
    registry.dispose();
  });
});
