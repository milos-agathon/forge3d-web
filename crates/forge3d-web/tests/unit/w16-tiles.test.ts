import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  Tileset,
  TilesetTraverser,
  TileBoundingVolume,
  computeTileSse,
  wgs84ToEcef,
  decodePnts,
  decodeB3dm,
  Tiles3dLayer,
  Forge3DError,
} from "../../src-ts/index.js";
import {
  multiplyTileMatrices,
  transformTilePoint,
} from "../../src-ts/tiles3d-bounds.js";
const fixture = (path: string) =>
  new Uint8Array(
    readFileSync(new URL("../fixtures/w16/" + path, import.meta.url)),
  );
const view = {
  position: [0, 0, 500] as const,
  viewportHeight: 1080,
  fovY: Math.PI / 4,
};
function document(refine = "REPLACE") {
  return {
    asset: { version: "1.0" },
    geometricError: 500,
    root: {
      boundingVolume: { sphere: [0, 0, 0, 100] },
      geometricError: 100,
      refine,
      content: { uri: "root.b3dm" },
      children: [
        {
          boundingVolume: { sphere: [-50, 0, 0, 50] },
          geometricError: 10,
          content: { uri: "one.b3dm" },
        },
        {
          boundingVolume: { sphere: [50, 0, 0, 50] },
          geometricError: 10,
          content: { uri: "two.pnts" },
        },
      ],
    },
  };
}
describe("W16 native OGC tile parsing, bounds and SSE", () => {
  it("bounds wide geographic regions around their SSE center", () => {
    const region = new TileBoundingVolume({
      region: [-Math.PI / 2, -Math.PI / 4, Math.PI / 2, Math.PI / 4, 0, 200],
    });
    const center = region.center();
    for (const lon of [-Math.PI / 2, 0, Math.PI / 2])
      for (const lat of [-Math.PI / 4, 0, Math.PI / 4]) {
        const p = wgs84ToEcef(lon, lat, 200);
        expect(
          Math.hypot(...p.map((v, i) => v - center[i]!)),
        ).toBeLessThanOrEqual(region.radius());
      }
    expect(
      () => new TileBoundingVolume({ region: [4, 0, 5, 1, 0, 20] }),
    ).toThrow();
  });
  it("matches pinned native real-payload camera selection/SSE records exactly", () => {
    const m = JSON.parse(
        new TextDecoder().decode(fixture("copc-ept-tiles-v1.json")),
      ),
      t = Tileset.fromJson(
        JSON.parse(new TextDecoder().decode(fixture("tileset.json"))),
        "https://example.org/tileset.json",
      );
    try {
      for (const record of m.tileSelections) {
        const selected = new TilesetTraverser().visibleTiles(t, record.view);
        expect(
          selected.map((n) => ({
            uri: new URL(n.tile.content!.uri).pathname.slice(1),
            depth: n.depth,
            sse: Number(n.sse.toFixed(m.sseDecimalPlaces)),
          })),
        ).toEqual(record.nodes);
      }
    } finally {
      t.dispose();
    }
  });
  it("parses tile count/depth and resolves remote / relative URIs", () => {
    const t = Tileset.fromJson(
      document(),
      "https://example.org/a/tileset.json",
    );
    expect(t.tileCount).toBe(3);
    expect(t.maxDepth).toBe(2);
    expect(t.resolveUri("../b/test.pnts")).toBe(
      "https://example.org/b/test.pnts",
    );
    expect(t.resolveUri("https://cdn.example.org/tile.b3dm")).toBe(
      "https://cdn.example.org/tile.b3dm",
    );
    t.dispose();
  });
  it("uses exact native center-distance SSE and separately exposes surface-distance SSE", () => {
    const bounds = new TileBoundingVolume({ sphere: [0, 0, 0, 10] });
    expect(computeTileSse(10, bounds, view.position, view)).toBeCloseTo(
      ((10 / 500) * 1080) / (2 * Math.tan(Math.PI / 8)),
      10,
    );
    expect(computeTileSse(10, bounds, [0, 0, 0])).toBeGreaterThan(1e38);
    expect(
      computeTileSse(10, bounds, view.position, view, true),
    ).toBeGreaterThan(computeTileSse(10, bounds, view.position, view));
    expect(computeTileSse(1, bounds, view.position)).toBeLessThan(
      computeTileSse(10, bounds, view.position),
    );
  });
  it("inherits ADD/REPLACE and respects depth / empty structural parents", () => {
    const t = Tileset.fromJson(document(), "https://example.org/tileset.json"),
      traverser = new TilesetTraverser({ sseThreshold: 1 });
    expect(traverser.visibleTiles(t, view).map((v) => v.tile.id)).toEqual([
      "root/0",
      "root/1",
    ]);
    traverser.sseThreshold = 1000;
    expect(traverser.visibleTiles(t, view).map((v) => v.tile.id)).toEqual([
      "root",
    ]);
    traverser.sseThreshold = 1;
    traverser.maxDepth = 0;
    expect(traverser.visibleTiles(t, view).map((v) => v.tile.id)).toEqual([
      "root",
    ]);
    const additive = Tileset.fromJson(
      document("ADD"),
      "https://example.org/tileset.json",
    );
    expect(
      new TilesetTraverser({ sseThreshold: 1 })
        .visibleTiles(additive, view)
        .map((v) => v.tile.id),
    ).toEqual(["root", "root/0", "root/1"]);
    delete (document().root as { content?: unknown }).content;
    t.root.content = undefined;
    traverser.maxDepth = 32;
    expect(traverser.visibleTiles(t, view)).toHaveLength(2);
    t.dispose();
    additive.dispose();
  });
  it("composes column-major transforms, preserves oriented boxes and geographic/ECEF bounds", () => {
    const m = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1],
      bounds = new TileBoundingVolume({
        box: [1, 2, 3, 2, 0, 0, 0, 3, 0, 0, 0, 4],
      }).transform(m);
    expect(bounds.data).toEqual([12, 26, 42, 4, 0, 0, 0, 9, 0, 0, 0, 16]);
    expect(bounds.aabb()).toEqual({ min: [8, 17, 26], max: [16, 35, 58] });
    expect(transformTilePoint(multiplyTileMatrices(m, m), [0, 0, 0])).toEqual([
      30, 80, 150,
    ]);
    expect(wgs84ToEcef(0, 0, 10)).toEqual([6378147, 0, 0]);
    const region = new TileBoundingVolume({
      region: [-0.01, -0.01, 0.01, 0.01, 0, 100],
    });
    expect(region.center()[0]).toBeCloseTo(6378187, 5);
    expect(region.aabb().max[0]).toBe(6378237);
    expect(region.transform(m).data).toEqual(region.data);
  });
  it("rejects corrupt/required-extension/unsupported/over-depth metadata structurally", () => {
    expect(() =>
      Tileset.fromJson(
        { ...document(), extensionsRequired: ["3DTILES_implicit_tiling"] },
        "https://example.org/t.json",
      ),
    ).toThrow(Forge3DError);
    expect(() =>
      Tileset.fromJson(document("BROKEN"), "https://example.org/t.json"),
    ).toThrow();
    expect(() =>
      Tileset.fromJson(document(), "https://example.org/t.json", {
        maxDepth: 0,
      }),
    ).toThrow();
    expect(() => new TileBoundingVolume({ sphere: [0, 0, 0, -1] })).toThrow();
    expect(() =>
      Tileset.fromJson(
        {
          ...document(),
          root: { ...document().root, content: { uri: "file:///etc/test" } },
        },
        "https://example.org/t.json",
      ),
    ).toThrow();
  });
});
describe("W16 real PNTS/B3DM payload contracts", () => {
  it("decodes binary globals, RGB565, constant RGBA, oct normals and batch IDs", () => {
    const binary = new Uint8Array(32),
      v = new DataView(binary.buffer);
    v.setUint32(0, 1, true);
    [1, 2, 3].forEach((n, i) => v.setFloat32(4 + i * 4, n, true));
    v.setUint16(16, 0xf800, true);
    binary.set([128, 128], 18);
    binary[20] = 0;
    binary.set([5, 6, 7, 8], 24);
    const make = (color: Record<string, unknown>) => {
      const table = new TextEncoder().encode(
          JSON.stringify({
            POINTS_LENGTH: { byteOffset: 0 },
            POSITION: { byteOffset: 4 },
            NORMAL_OCT16P: { byteOffset: 18 },
            BATCH_LENGTH: 1,
            BATCH_ID: { byteOffset: 20, componentType: "UNSIGNED_BYTE" },
            ...color,
          }),
        ),
        out = new Uint8Array(28 + table.length + binary.length),
        h = new DataView(out.buffer);
      out.set(new TextEncoder().encode("pnts"));
      h.setUint32(4, 1, true);
      h.setUint32(8, out.length, true);
      h.setUint32(12, table.length, true);
      h.setUint32(16, binary.length, true);
      out.set(table, 28);
      out.set(binary, 28 + table.length);
      return decodePnts(out);
    };
    const packed = make({ RGB565: { byteOffset: 16 } });
    expect([...packed.points.positions]).toEqual([1, 2, 3]);
    expect([...packed.points.colors!]).toEqual([255, 0, 0]);
    expect(packed.points.normals![2]).toBeCloseTo(1, 4);
    expect([...packed.points.ids!]).toEqual([0]);
    expect([
      ...make({ CONSTANT_RGBA: { byteOffset: 24 } }).points.colors!,
    ]).toEqual([5, 6, 7, 8]);
  });
  it("decodes colored points exactly, not a synthetic success record", () => {
    const p = decodePnts(fixture("colored.pnts"));
    expect(p.pointCount).toBe(3);
    expect([...p.points.positions]).toEqual([
      Math.fround(-0.6),
      0,
      0,
      0,
      0,
      0,
      Math.fround(0.6),
      0,
      0,
    ]);
    expect([...p.points.colors!]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  });
  it("quantization and large RTC retain Float64 precision", () => {
    const p = decodePnts(fixture("quantized.pnts"));
    expect([...p.points.positions]).toEqual([
      10000010,
      20000020 + (32768 / 65535) * 8,
      30000042,
      10000014,
      20000020,
      30000030 + (32768 / 65535) * 12,
    ]);
    expect(p.rtcCenter).toEqual([10000000, 20000000, 30000000]);
  });
  it("b3dm unwraps W15 GLB geometry, metadata and RTC", async () => {
    const m = await decodeB3dm(fixture("triangle.b3dm"));
    expect(m.batchLength).toBe(1);
    expect(m.rtcCenter).toEqual([4, 5, 6]);
    expect(m.gltf.primitives[0]!.mesh.positions.length).toBe(9);
    expect([...m.gltf.primitives[0]!.mesh.indices]).toEqual([0, 1, 2]);
    expect(m.batchTable.name).toEqual(["native-triangle"]);
  });
  it("rejects versions, bad table spans, short attributes and cancellation", async () => {
    const input = fixture("colored.pnts");
    const corrupt = input.slice();
    new DataView(corrupt.buffer).setUint32(16, 100000, true);
    expect(() => decodePnts(corrupt)).toThrow();
    const version = input.slice();
    new DataView(version.buffer).setUint32(4, 2, true);
    expect(() => decodePnts(version)).toThrow();
    const bad = fixture("triangle.b3dm").slice();
    const bv = new DataView(bad.buffer),
      start =
        28 + [12, 16, 20, 24].reduce((n, i) => n + bv.getUint32(i, true), 0);
    bv.setUint32(start + 8, 999999, true);
    await expect(decodeB3dm(bad)).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    expect(() => decodePnts(input, { signal: abort.signal })).toThrow();
    expect(() => decodePnts(input, { maxBytes: 20 })).toThrow();
  });
  it("loads external trees / URI payloads, caches, and transforms geometry independently", async () => {
    const fetcher = async (uri: string) =>
        new Response(fixture(new URL(uri).pathname.slice(1))),
      t = await Tileset.load("https://example.org/external.json", {
        fetch: fetcher,
      });
    const layer = new Tiles3dLayer(t, { origin: [0, 0, 0] });
    await layer.update({ ...view, position: [0, 0, 10] });
    expect(layer.stats().pointCount).toBe(3);
    expect(layer.stats().triangles).toBe(1);
    expect([...layer.pointData().colors!]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]);
    const mesh = layer.meshes()[0]!.mesh;
    expect([...mesh.positions.slice(0, 3)]).toEqual([4, 5, 6]);
    expect(t.tileCount).toBe(3);
    expect(t.stats().externalTilesets).toBe(1);
    const misses = layer.stats().cache.misses;
    await layer.update({ ...view, position: [0, 0, 10] });
    expect(layer.stats().cache.misses).toBe(misses);
    expect(layer.stats().cache.hits).toBeGreaterThan(0);
    layer.dispose();
    expect(layer.stats().loadedBytes).toBe(0);
    t.dispose();
  });
  it("detects an external tileset cycle and keeps a loaded view on failure", async () => {
    const cycle = {
        asset: { version: "1.0" },
        root: {
          boundingVolume: { sphere: [0, 0, 0, 1] },
          content: { uri: "cycle.json" },
        },
      },
      t = Tileset.fromJson(cycle, "https://example.org/cycle.json");
    await expect(t.expandExternal(t.root)).rejects.toMatchObject({
      details: { reason: "tileset-cycle" },
    });
    t.dispose();
  });
  it("allows repeated external resources on independent ancestry paths", async () => {
    const t = Tileset.fromJson(
      {
        asset: { version: "1.0" },
        root: {
          boundingVolume: { sphere: [0, 0, 0, 10] },
          children: [0, 1].map(() => ({
            boundingVolume: { sphere: [0, 0, 0, 1] },
            content: { uri: "shared.json" },
          })),
        },
      },
      "https://example.org/t.json",
      {
        fetch: async () =>
          Response.json({
            asset: { version: "1.0" },
            root: {
              boundingVolume: { sphere: [0, 0, 0, 1] },
              content: { uri: "colored.pnts" },
            },
          }),
      },
    );
    try {
      expect(await t.expandExternal(t.root.children[0]!)).toBe(true);
      expect(await t.expandExternal(t.root.children[1]!)).toBe(true);
      expect(t.tileCount).toBe(5);
      expect(t.root.children[0]!.children[0]!.id).not.toBe(
        t.root.children[1]!.children[0]!.id,
      );
    } finally {
      t.dispose();
    }
  });
  it("recognizes extensionless external content and fetches each binary body once", async () => {
    const requests: string[] = [];
    const t = Tileset.fromJson(
      {
        asset: { version: "1.0" },
        root: {
          boundingVolume: { sphere: [0, 0, 0, 10] },
          content: { uri: "service/tiles?version=1" },
        },
      },
      "https://example.org/root.json",
      {
        fetch: async (uri) => {
          requests.push(uri);
          if (uri.includes("/service/tiles?"))
            return new Response(
              "\ufeff \n" +
                JSON.stringify({
                  asset: { version: "1.0" },
                  root: {
                    boundingVolume: { sphere: [0, 0, 0, 10] },
                    content: { uri: "../colored.pnts" },
                  },
                }),
            );
          return new Response(fixture("colored.pnts"));
        },
      },
    );
    const layer = new Tiles3dLayer(t);
    try {
      await layer.update(view);
      await layer.update(view);
      expect(layer.stats().pointCount).toBe(3);
      expect(t.stats().externalTilesets).toBe(1);
      expect(requests).toEqual([
        "https://example.org/service/tiles?version=1",
        "https://example.org/colored.pnts",
      ]);
    } finally {
      layer.dispose();
      t.dispose();
    }
  });
  it("keeps the committed tile content on cancelled and failed replacement", async () => {
    const t = Tileset.fromJson(document(), "https://example.org/t.json", {
        fetch: async (uri) => {
          if (uri.endsWith("root.b3dm"))
            return new Response(fixture("triangle.b3dm"));
          throw Error("Unavailable child");
        },
      }),
      l = new Tiles3dLayer(t, { sseThreshold: 10000 });
    try {
      await l.update(view);
      const before = l.loadedTiles();
      l.traverser.sseThreshold = 1;
      await expect(l.update(view)).rejects.toMatchObject({ code: "IO_ERROR" });
      expect(l.loadedTiles()).toEqual(before);
      const abort = new AbortController();
      abort.abort();
      await expect(l.update(view, abort.signal)).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      });
      expect(l.loadedTiles()).toEqual(before);
    } finally {
      l.dispose();
      t.dispose();
    }
  });
});
