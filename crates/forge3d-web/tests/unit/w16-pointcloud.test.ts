import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  PointBuffer,
  transferPointData,
  OctreeKey,
  PointCloudTraverser,
  computePointSse,
  CopcDataset,
  parseCopcHierarchy,
  EptDataset,
  parseEptBinary,
  parseLasHeader,
  parseLasRecords,
  PointCloudLayer,
  AdaptivePointBudget,
  Forge3DError,
  Forge3DWorkerPool,
} from "../../src-ts/index.js";
import { PointCache } from "../../src-ts/pointcloud-common.js";
import { PointSource } from "../../src-ts/pointcloud-source.js";
import { decodeLazChunk } from "../../src-ts/laz-decoder.js";
import type {
  PointCloudDataset,
  PointNode,
  PointData,
} from "../../src-ts/index.js";
const fixture = (path: string) =>
  new Uint8Array(
    readFileSync(new URL("../fixtures/w16/" + path, import.meta.url)),
  );
const view = {
  position: [0, 0, 10] as const,
  viewportHeight: 1080,
  fovY: Math.PI / 4,
};
const header = parseLasHeader(fixture("ellipsoid.copc.laz"));
describe("W16 decoder hard-stop admission and queue bounds", () => {
  it("rejects LAZ dispatch without a terminable worker and validates timeout bounds", async () => {
    const channel = new MessageChannel();
    const pool = new Forge3DWorkerPool({ workerFactory: () => channel.port1,
      mainThreadHandler: () => undefined });
    try {
      await expect(pool.run({}, { requireHardStop: true })).rejects.toMatchObject({
        code: "UNSUPPORTED_FEATURE", details: { reason: "worker-hard-stop-unavailable" },
      });
      for (const timeoutMs of [0, -1, NaN, 1.5, 2 ** 31])
        await expect(pool.run({}, { timeoutMs })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(pool.getDiagnostics()).toMatchObject({ active: 0, queued: 0 });
    } finally { pool.dispose(); channel.port2.close(); }
  });
  it("expires queued jobs and aborts queued jobs without transferring their input", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: unknown[] = [];
    const pool = new Forge3DWorkerPool({ mainThreadHandler: async (payload) => { seen.push(payload); await gate; } });
    try {
      const active = pool.run("active");
      await Promise.resolve();
      const bytes = new Uint8Array([1, 2, 3]);
      const expired = pool.run(bytes, { timeoutMs: 10, transfer: [bytes.buffer] });
      const deadline = expect(expired).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
        details: { reason: "worker-deadline-exceeded", timeoutMs: 10 } });
      await vi.advanceTimersByTimeAsync(10);
      await deadline;
      const controller = new AbortController();
      const aborted = pool.run(bytes, { signal: controller.signal, transfer: [bytes.buffer] });
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
      expect(bytes.byteLength).toBe(3);
      expect(pool.getDiagnostics()).toMatchObject({ active: 1, queued: 0 });
      release(); await active;
      expect(seen).toEqual(["active"]);
    } finally { pool.dispose(); vi.useRealTimers(); }
  });
  it("terminates owned workers on dispose and clears all job timers", async () => {
    vi.useFakeTimers();
    const channel = new MessageChannel(), terminate = vi.fn();
    const pool = new Forge3DWorkerPool({ size: 1,
      workerFactory: () => ({ port: channel.port1, terminate }), mainThreadHandler: () => undefined });
    try {
      const active = pool.run("active", { requireHardStop: true });
      const queued = pool.run("queued");
      pool.dispose();
      await expect(active).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
      await expect(queued).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
      expect(terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(pool.getDiagnostics()).toMatchObject({ active: 0, queued: 0 });
    } finally { pool.dispose(); channel.port2.close(); vi.useRealTimers(); }
  });
});
describe("W16 native point buffer and octree contracts", () => {
  it("retains immutable point arrays after another owner releases its handle", () => {
    const original = new PointBuffer({
        positions: new Float64Array([1, 2, 3]),
      }),
      retained = original.retain();
    original.dispose();
    expect(original.cpuBytes).toBe(0);
    const copy = retained.data();
    copy.positions[0] = 999;
    expect(retained.point(0).position).toEqual([1, 2, 3]);
    retained.dispose();
    expect(retained.cpuBytes).toBe(0);
  });
  it("interleaves colors/default white and historical viewer stride exactly", () => {
    const buffer = new PointBuffer({
      positions: new Float32Array([0, 10, 0, 1, 20, 2]),
      colors: new Uint8Array([255, 0, 0, 0, 255, 0]),
    });
    expect([...buffer.createGpuBuffer()]).toEqual([
      0, 10, 0, 1, 0, 0, 1, 20, 2, 0, 1, 0,
    ]);
    expect(
      buffer.createViewerGpuBuffer({ min: [0, 10, 0], max: [10, 20, 10] })
        .byteLength,
    ).toBe(96);
    expect([
      ...buffer
        .createViewerGpuBuffer({ min: [0, 10, 0], max: [10, 20, 10] })
        .slice(0, 12),
    ]).toEqual([0, 10, 0, 0, 1, 0, 0, 0.5, 1, 0, 0, 0]);
    expect([
      ...new PointBuffer({
        positions: new Float32Array([1, 2, 3]),
      }).createGpuBuffer(),
    ]).toEqual([1, 2, 3, 1, 1, 1]);
  });
  it("rejects malformed arrays and protects owned buffers on transfer/disposal", () => {
    expect(() => new PointBuffer({ positions: new Float32Array([1]) })).toThrow(
      Forge3DError,
    );
    expect(
      () => new PointBuffer({ positions: new Float32Array([1, 2, NaN]) }),
    ).toThrow();
    expect(
      () =>
        new PointBuffer({
          positions: new Float32Array([1, 2, 3]),
          colors: new Uint8Array([1]),
        }),
    ).toThrow();
    const input = { positions: new Float64Array([10000000.001, 2, 3]) },
      buffer = new PointBuffer(input);
    input.positions[0] = 0;
    expect(buffer.createGpuBuffer([10000000, 0, 0])[0]).toBeCloseTo(0.001, 6);
    const owned = buffer.data(),
      packet = transferPointData(owned);
    structuredClone(packet.data, { transfer: packet.transfer });
    expect(packet.data.positions.byteLength).toBe(0);
    expect(owned.positions.byteLength).toBe(24);
    buffer.dispose();
    expect(buffer.cpuBytes).toBe(0);
    expect(() => buffer.data()).toThrow();
  });
  it("computes asymmetric octant bounds, parents, keys and SSE", () => {
    const key = new OctreeKey(2, 3, 0, 2);
    expect(key.toString()).toBe("2-3-0-2");
    expect(key.parent()!.toString()).toBe("1-1-0-1");
    expect(key.bounds({ min: [0, 10, 20], max: [8, 26, 52] })).toEqual({
      min: [6, 10, 36],
      max: [8, 14, 44],
    });
    expect(() => OctreeKey.parse("1-2-0-0")).toThrow();
    expect(() => OctreeKey.parse("1--1-0-0")).toThrow();
    expect(
      computePointSse({ min: [-1, -1, -1], max: [1, 1, 1] }, view),
    ).toBeCloseTo(
      ((Math.sqrt(3) / 10) * 1080) / (2 * Math.tan(Math.PI / 8)),
      8,
    );
  });
  it("LRU pressure cannot exceed budget or evict on failed admission", () => {
    const cache = new PointCache<number>(10);
    cache.put("a", 1, 6);
    cache.put("b", 2, 4);
    expect(cache.get("a")).toBe(1);
    cache.put("c", 3, 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.bytes).toBe(10);
    expect(() => cache.put("huge", 5, 11)).toThrow();
    expect(cache.bytes).toBe(10);
    cache.clear();
    expect(cache.bytes).toBe(0);
  });
  it("adaptive budget responds to sustained p95 with hysteresis and hard bounds", () => {
    const b = new AdaptivePointBudget({
      targetFrameMs: 10,
      minPoints: 100,
      maxPoints: 1000,
      sampleFrames: 2,
    });
    expect(b.observe(30, 1000)).toBe(1000);
    expect(b.observe(30, 1000)).toBe(800);
    expect(b.observe(2, 800)).toBe(800);
    expect(b.observe(2, 800)).toBe(880);
    expect(b.observe(30, 100)).toBe(100);
    expect(b.observe(30, 100)).toBe(100);
    expect(() => b.observe(NaN, 100)).toThrow();
  });
});
describe("W16 LAS and hierarchy parsing", () => {
  it("rejects real chunk truncation and forged layer lengths before native allocation", async () => {
    const bytes = fixture("ellipsoid.copc.laz"),
      v = new DataView(bytes.buffer),
      offset = v.getUint32(375 + 54 + 40, true),
      entry = new DataView(bytes.buffer, offset, 32),
      start = Number(entry.getBigUint64(16, true)),
      size = entry.getInt32(24, true),
      count = entry.getInt32(28, true),
      chunk = bytes.slice(start, start + size);
    await expect(
      decodeLazChunk(chunk.subarray(0, chunk.length - 1), header, count),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "invalid-laz" },
    });
    const forged = chunk.slice();
    new DataView(forged.buffer).setUint32(
      header.recordLength + 4,
      0xffffffff,
      true,
    );
    await expect(decodeLazChunk(forged, header, count)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      decodeLazChunk(chunk, { ...header, pointFormat: 9 }, count),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "invalid-copc" },
    });
  });
  it("uses LAS offsets, record format flag and independent fixture bounds", () => {
    const bytes = fixture("autzen_trim.laz"),
      h = parseLasHeader(bytes),
      expected = JSON.parse(
        new TextDecoder().decode(fixture("copc-ept-tiles-v1.json")),
      ).autzen;
    expect(h.compressed).toBe(true);
    expect(h.pointCount).toBe(expected.count);
    for (const side of ["min", "max"] as const)
      for (let i = 0; i < 3; i++)
        expect(h.bounds[side][i]).toBeCloseTo(expected.bounds[side][i], 7);
  });
  for (const [format, length, rgb] of [
    [2, 26, 20],
    [3, 34, 28],
    [6, 30, -1],
    [7, 36, 30],
    [8, 38, 30],
  ] as const)
    it(`parses exact format ${format} RGB/intensity/classification offsets`, () => {
      const raw = new Uint8Array(length),
        v = new DataView(raw.buffer);
      v.setInt32(0, 101, true);
      v.setInt32(4, -203, true);
      v.setInt32(8, 307, true);
      v.setUint16(12, 30000, true);
      v.setUint8(format >= 6 ? 16 : 15, format >= 6 ? 201 : 7);
      if (rgb >= 0) {
        v.setUint16(rgb, 65535, true);
        v.setUint16(rgb + 2, 32768, true);
        v.setUint16(rgb + 4, 256, true);
      }
      const p = parseLasRecords(raw, 1, {
        ...header,
        recordLength: length,
        pointFormat: format,
        scale: [0.01, 0.02, 0.03],
        offset: [100, 200, 300],
      });
      expect([...p.positions]).toEqual([101.01, 195.94, 309.21]);
      expect([...p.intensities!]).toEqual([30000]);
      expect([...p.classifications!]).toEqual([format >= 6 ? 201 : 7]);
      expect(p.colors ? [...p.colors] : null).toEqual(
        rgb >= 0 ? [255, 128, 1] : null,
      );
    });
  it("preserves hierarchy page references and empty parents, rejects truncation/unsafe u64", () => {
    const bytes = new Uint8Array(64),
      v = new DataView(bytes.buffer);
    v.setBigUint64(16, 1000n, true);
    v.setInt32(24, 64, true);
    v.setInt32(28, -1, true);
    v.setInt32(32, 1, true);
    v.setInt32(36, 1, true);
    expect(parseCopcHierarchy(bytes).map((e) => e.pointCount)).toEqual([-1, 0]);
    expect(() => parseCopcHierarchy(bytes.subarray(1))).toThrow();
    v.setBigUint64(16, 2n ** 63n, true);
    expect(() => parseCopcHierarchy(bytes)).toThrow();
  });
  it("binary EPT dimensions preserve source precision, reordering and scale", () => {
    const meta = JSON.parse(new TextDecoder().decode(fixture("ept/ept.json"))),
      data = parseEptBinary(fixture("ept/ept-data/0-0-0-0.bin"), meta.schema),
      expected = JSON.parse(
        new TextDecoder().decode(fixture("copc-ept-tiles-v1.json")),
      ).autzen;
    expect(data.positions.length / 3).toBe(128);
    expect([...data.positions.slice(0, 9)]).toEqual(expected.firstPositions);
    expect([...data.colors!.slice(0, 9)]).toEqual(expected.firstColors);
    expect(() => parseEptBinary(new Uint8Array(1), meta.schema)).toThrow();
    expect(() =>
      parseEptBinary(new Uint8Array(), [
        { name: "X", type: "floating", size: 1 },
      ]),
    ).toThrow();
  });
});
function dataset(): PointCloudDataset {
  const root: PointNode = {
      key: "0-0-0-0",
      depth: 0,
      pointCount: 4,
      spacing: 1,
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      children: ["1-0-0-0", "1-1-1-1"],
    },
    children = root.children.map((key) => ({
      key,
      depth: 1,
      pointCount: 3,
      spacing: 0.5,
      bounds: OctreeKey.parse(key).bounds(root.bounds),
      children: [],
    }));
  return {
    bounds: root.bounds,
    totalPoints: 10,
    crs: undefined,
    rootNode: () => root,
    async children(key) {
      return key === root.key ? children : [];
    },
    async readPoints(key) {
      return { positions: new Float64Array((key === root.key ? 4 : 3) * 3) };
    },
    dispose() {},
  };
}
describe("W16 selection, cancellation and layer ownership", () => {
  it("never descends below an additive node rejected by budget", async () => {
    const d = dataset(),
      calls: string[] = [],
      children = d.children.bind(d);
    d.children = async (key, signal) => {
      calls.push(key);
      return children(key, signal);
    };
    expect(
      await new PointCloudTraverser({
        mode: "add",
        pointBudget: 3,
      }).visibleNodes(d, view),
    ).toEqual([]);
    expect(calls).toEqual([]);
    const selected = await new PointCloudTraverser({
      mode: "add",
      pointBudget: 7,
    }).visibleNodes(d, view);
    expect(selected.map((n) => n.key)).toEqual(["0-0-0-0", "1-1-1-1"]);
    expect(calls).not.toContain("1-0-0-0");
  });
  it("reproduces native leaf priority and enforces budget inside a node", async () => {
    const d = dataset(),
      traverser = new PointCloudTraverser({ pointBudget: 6 });
    expect((await traverser.visibleNodes(d, view)).map((n) => n.key)).toEqual([
      "1-1-1-1",
      "1-0-0-0",
    ]);
    traverser.setPointBudget(2);
    expect(
      await traverser.visibleNodes(d, { ...view, position: [0, 0, 0] }),
    ).toEqual([]);
    const additive = new PointCloudTraverser({ mode: "add", pointBudget: 7 });
    expect((await additive.visibleNodes(d, view)).map((n) => n.key)).toEqual([
      "0-0-0-0",
      "1-1-1-1",
    ]);
  });
  it("culls a WebGPU frustum and honors maximum depth / zero budget", async () => {
    const t = new PointCloudTraverser({ maxDepth: 0, pointBudget: 4 });
    expect((await t.visibleNodes(dataset(), view))[0]!.depth).toBe(0);
    t.setPointBudget(0);
    expect(await t.visibleNodes(dataset(), view)).toEqual([]);
    expect(
      await new PointCloudTraverser().visibleNodes(dataset(), {
        ...view,
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
      }),
    ).toEqual([]);
  });
  it("cancel/failed update retains prior selection and disposal releases owned data", async () => {
    const d = dataset(),
      layer = new PointCloudLayer(d, { pointBudget: 7 });
    await layer.update(view);
    const before = layer.stats();
    const abort = new AbortController();
    abort.abort();
    await expect(layer.update(view, abort.signal)).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    expect(layer.stats()).toEqual(before);
    layer.traverser.mode = "replace";
    layer.traverser.setPointBudget(6);
    d.readPoints = async () => {
      throw new Forge3DError("IO_ERROR", "bad chunk");
    };
    await expect(layer.update(view)).rejects.toThrow();
    expect(layer.stats()).toEqual({ ...before, pointBudget: 6 });
    layer.dispose();
    expect(layer.stats().cpuBytes).toBe(0);
  });
  it("COPC opens from a ranged Blob, metadata bounded and cached", async () => {
    const bytes = fixture("ellipsoid.copc.laz"),
      d = await CopcDataset.open(new Blob([bytes]));
    expect(d.totalPoints).toBe(100000);
    expect(d.rootNode().pointCount).toBeGreaterThan(0);
    const stats = d.stats();
    expect(stats.ranges.bytesRequested / bytes.length).toBeLessThan(0.25);
    expect((await d.children("0-0-0-0")).length).toBeGreaterThan(0);
    d.dispose();
    expect(() => d.rootNode()).toThrow();
  });
  it("EPT relative resources and lazy pages use the W02 byte adapters", async () => {
    const fetcher = async (uri: string) =>
      new Response(
        fixture("ept/" + new URL(uri).pathname.slice("/ept/".length)),
      );
    const d = await EptDataset.open("https://example.org/ept/ept.json", {
      fetch: fetcher,
    });
    expect(d.crs).toBe("EPSG:2992");
    expect((await d.readPoints("0-0-0-0")).positions.length).toBe(384);
    expect((await d.readPoints("0-0-0-0")).colors!.length).toBe(384);
    expect(d.stats().decoded.hits).toBe(1);
    d.dispose();
  });
  it("matches recorded real-data native camera keys/counts and quantized SSE exactly", async () => {
    const m = JSON.parse(
        new TextDecoder().decode(fixture("copc-ept-tiles-v1.json")),
      ),
      copc = await CopcDataset.open(new Blob([fixture("ellipsoid.copc.laz")])),
      ept = await EptDataset.open("https://example.org/ept/ept.json", {
        fetch: async (uri) =>
          new Response(fixture(new URL(uri).pathname.slice(1))),
      }),
      workload = await EptDataset.open(
        "https://example.org/workload-ept/ept.json",
        {
          fetch: async (uri) =>
            new Response(fixture(new URL(uri).pathname.slice(1))),
        },
      );
    try {
      for (const record of m.cameraSelections) {
        const selected = await new PointCloudTraverser(
          record.options,
        ).visibleNodes(
          record.source === "copc"
            ? copc
            : record.source === "ept"
              ? ept
              : workload,
          record.view,
        );
        expect(
          selected.map((n) => ({
            key: n.key,
            pointCount: n.pointCount,
            sse: Number(n.sse.toFixed(m.sseDecimalPlaces)),
          })),
        ).toEqual(record.nodes);
      }
    } finally {
      copc.dispose();
      ept.dispose();
      workload.dispose();
    }
  });
  it("shares lazy EPT pages while cancelling one subscriber and preserving the other", async () => {
    let requests = 0,
      release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r)),
      metadata = JSON.parse(new TextDecoder().decode(fixture("ept/ept.json")));
    const fetcher = async (uri: string) => {
      const path = new URL(uri).pathname;
      if (path.endsWith("/ept.json")) return Response.json(metadata);
      if (path.endsWith("/0-0-0-0.json"))
        return Response.json({ "0-0-0-0": 0, "1-0-0-0": -1 });
      requests++;
      await gate;
      return Response.json({ "1-0-0-0": 128, "2-0-0-0": 0 });
    };
    const d = await EptDataset.open("https://example.org/ept/ept.json", {
        fetch: fetcher,
      }),
      abort = new AbortController(),
      cancelled = d.children("1-0-0-0", abort.signal),
      other = d.children("1-0-0-0");
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    release();
    expect((await other).map((n) => n.key)).toEqual(["2-0-0-0"]);
    expect(requests).toBe(1);
    d.dispose();
  });
  it("reopens EPT from owned persistent bytes offline and normalizes midflight IO cancellation", async () => {
    const bytes = new Map<string, Uint8Array>(),
      cache = {
        kind: "test",
        async get(k: string) {
          return bytes.get(k)?.slice();
        },
        async put(k: string, v: Uint8Array) {
          bytes.set(k, v.slice());
        },
        async delete(k: string) {
          bytes.delete(k);
        },
        async clear() {
          bytes.clear();
        },
        stats() {
          return {
            hits: 0,
            misses: 0,
            checksumFailures: 0,
            entries: bytes.size,
            bytes: 0,
          };
        },
      };
    const source = await EptDataset.open("https://example.org/ept/ept.json", {
      persistentCache: cache,
      fetch: async (uri) =>
        new Response(fixture(new URL(uri).pathname.slice(1))),
    });
    await source.readPoints("0-0-0-0");
    source.dispose();
    let calls = 0;
    const offline = await EptDataset.open("https://example.org/ept/ept.json", {
      persistentCache: cache,
      fetch: async () => {
        calls++;
        throw Error("offline");
      },
    });
    expect((await offline.readPoints("0-0-0-0")).positions.length).toBe(384);
    expect(calls).toBe(0);
    offline.dispose();
    const io = new PointSource({
        fetch: async (_, init) =>
          new Promise((_, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Cancelled", "AbortError")),
            ),
          ),
      }),
      abort = new AbortController(),
      pending = io.read("https://example.org/slow", abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    io.dispose();
  });
});
