// W08 (F3/F5): CogDataset against the committed G1 fixtures through a
// mocked Range-serving fetch and Blob sources — metadata vs truth JSON,
// exact tile values (incl. the predictor/DEFLATE fixture), overview
// selection, cache hits/budget, bounded transfer, typed range errors,
// and AbortSignal cancellation.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CogDataset, createCogWorkerHandler } from "../../src-ts/cog.js";
import { RangeScheduler } from "../../src-ts/range-scheduler.js";
import type { RangeFetchLike } from "../../src-ts/range-scheduler.js";

const GOLDEN = fileURLToPath(new URL("../golden/w08/", import.meta.url));

interface TruthLevel {
  level: number;
  factor: number;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tilesAcross: number;
  tilesDown: number;
}

interface TruthJson {
  file: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  dtype: string[];
  nodata: number | null;
  crs: string | null;
  epsg: number | null;
  bounds: number[];
  transform: number[];
  levels: TruthLevel[];
  samples: Record<string, number>[];
  tileSha256: string[];
}

async function fixture(name: string): Promise<Blob> {
  const bytes = await readFile(`${GOLDEN}${name}`);
  return new Blob([bytes]);
}

async function truth(name: string): Promise<TruthJson> {
  return JSON.parse(
    await readFile(`${GOLDEN}${name}`, "utf-8"),
  ) as TruthJson;
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function tileDigest(tile: Float32Array): Promise<string> {
  return sha256Hex(
    new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength),
  );
}

describe("CogDataset — predictor-deflate-u16.tif", () => {
  it("parses metadata matching the truth JSON", async () => {
    const expected = await truth("predictor-deflate-u16.json");
    const cog = await CogDataset.open(await fixture(expected.file));
    try {
      expect(cog.width).toBe(expected.width);
      expect(cog.height).toBe(expected.height);
      expect(cog.overviewCount).toBe(1);
      expect(cog.bitsPerSample).toBe(16);
      expect(cog.sampleFormat).toBe(1);
      expect(cog.samplesPerPixel).toBe(1);
      expect(cog.compression).toBe(8); // DEFLATE
      expect(cog.nodata).toBeNull();
      expect(cog.crs).toBeNull();
      const info = cog.ifdInfo(0);
      expect(info.tileWidth).toBe(16);
      expect(info.tileHeight).toBe(16);
      expect(info.tilesAcross).toBe(1);
      expect(info.tilesDown).toBe(1);
      expect(cog.bounds).toEqual([0, 0, 16, 16]);
    } finally {
      cog.dispose();
    }
  });

  it("decodes the exact (arange*3)+7 values through DEFLATE+predictor 2", async () => {
    const cog = await CogDataset.open(
      await fixture("predictor-deflate-u16.tif"),
    );
    try {
      const tile = await cog.readTile(0, 0, 0);
      expect(tile.length).toBe(256);
      for (let i = 0; i < 256; i += 1) {
        expect(tile[i]).toBe(i * 3 + 7);
      }
      // Truth pixel samples.
      expect(tile[0]).toBe(7);
      expect(tile[8 * 16 + 8]).toBe(415);
      expect(tile[255]).toBe(772);
      // Exact decoded-byte digest.
      const expected = await truth("predictor-deflate-u16.json");
      expect(await tileDigest(tile)).toBe(expected.tileSha256[0]);
    } finally {
      cog.dispose();
    }
  });
});

describe("CogDataset — rainier-cog.tif", () => {
  it("exposes every overview level with truth dims", async () => {
    const expected = await truth("rainier-cog.json");
    const cog = await CogDataset.open(await fixture(expected.file));
    try {
      expect(cog.width).toBe(1024);
      expect(cog.height).toBe(1024);
      expect(cog.overviewCount).toBe(3);
      expect(cog.nodata).toBe(-9999);
      expect(cog.crs).toBe("EPSG:4326");
      for (const level of expected.levels) {
        const info = cog.ifdInfo(level.level);
        expect(info.width).toBe(level.width);
        expect(info.height).toBe(level.height);
        expect(info.tileWidth).toBe(level.tileWidth);
        expect(info.tileHeight).toBe(level.tileHeight);
        expect(info.tilesAcross).toBe(level.tilesAcross);
        expect(info.tilesDown).toBe(level.tilesDown);
        expect(info.tileCount).toBe(
          level.tilesAcross * level.tilesDown,
        );
      }
      for (let i = 0; i < 4; i += 1) {
        expect(cog.bounds[i]).toBeCloseTo(expected.bounds[i]!, 6);
      }
    } finally {
      cog.dispose();
    }
  });

  it("reads tile (0,0) at every level with truth digests", async () => {
    const expected = await truth("rainier-cog.json");
    const cog = await CogDataset.open(await fixture(expected.file));
    try {
      for (let level = 0; level < expected.levels.length; level += 1) {
        const tile = await cog.readTile(0, 0, level);
        const info = expected.levels[level]!;
        expect(tile.length).toBe(info.tileWidth * info.tileHeight);
        expect(await tileDigest(tile)).toBe(expected.tileSha256[level]);
      }
      // Fixed pixel samples: tile (0,0) sample 0 == image pixel (0,0).
      const tile0 = await cog.readTile(0, 0, 0);
      expect(tile0[0]).toBeCloseTo(expected.samples[0]!["0,0"]!, 5);
      const tile2 = await cog.readTile(0, 0, 2);
      expect(tile2[0]).toBeCloseTo(expected.samples[2]!["0,0"]!, 5);
    } finally {
      cog.dispose();
    }
  });

  it("clamps lod selection and resolves overviews by resolution", async () => {
    const cog = await CogDataset.open(await fixture("rainier-cog.tif"));
    try {
      expect(cog.selectOverview(0)).toBe(0);
      expect(cog.selectOverview(2)).toBe(2);
      expect(cog.selectOverview(99)).toBe(2);
      expect(cog.selectOverview(-3)).toBe(0);
      const baseResolution = Math.abs(cog.geoTransform![1]);
      expect(cog.selectOverviewForResolution(baseResolution)).toBe(0);
      expect(
        cog.selectOverviewForResolution(baseResolution * 8),
      ).toBe(2);
    } finally {
      cog.dispose();
    }
  });

  it("rejects out-of-range tiles and levels", async () => {
    const cog = await CogDataset.open(await fixture("rainier-cog.tif"));
    try {
      await expect(cog.readTile(4, 0, 0)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(cog.readTile(0, -1, 0)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(() => cog.ifdInfo(9)).toThrowError(/out of range/);
    } finally {
      cog.dispose();
    }
  });

  it("serves repeat reads from the decoded-tile cache", async () => {
    const cog = await CogDataset.open(await fixture("rainier-cog.tif"));
    try {
      await cog.readTile(0, 0, 0);
      const before = cog.stats();
      await cog.readTile(0, 0, 0);
      const after = cog.stats();
      expect(after.cacheHits).toBe(before.cacheHits + 1);
      expect(after.range.httpRequests).toBe(before.range.httpRequests);
    } finally {
      cog.dispose();
    }
  });

  it("evicts decoded tiles under the byte budget", async () => {
    // Two decoded float32 tiles are 512 KiB; a 300 KiB budget must
    // evict the first when the second lands.
    const cog = await CogDataset.open(await fixture("rainier-cog.tif"), {
      cacheSizeMb: 0.29296875, // 307200 bytes
    });
    try {
      await cog.readTile(0, 0, 0);
      await cog.readTile(1, 0, 0);
      const stats = cog.stats();
      expect(stats.cacheEvictions).toBeGreaterThanOrEqual(1);
      expect(stats.memoryUsedBytes).toBeLessThanOrEqual(
        stats.memoryBudgetBytes,
      );
    } finally {
      cog.dispose();
    }
  });

  it("transfers a bounded prefix for a single-tile read (<25%)", async () => {
    const bytes = await readFile(`${GOLDEN}rainier-cog.tif`);
    const scheduler = new RangeScheduler();
    const cog = await CogDataset.open(new Blob([bytes]), { scheduler });
    try {
      await cog.readTile(0, 0, 0);
      const transferred = scheduler.stats().bytesTransferred;
      expect(transferred).toBeGreaterThan(0);
      expect(transferred).toBeLessThan(bytes.byteLength * 0.25);
    } finally {
      cog.dispose();
      scheduler.dispose();
    }
  });
});

describe("CogDataset — landcover-rgba-cog.tif", () => {
  it("reads RGBA tiles from a 4-band uint8 COG", async () => {
    const expected = await truth("landcover-rgba-cog.json");
    const cog = await CogDataset.open(await fixture(expected.file));
    try {
      expect(cog.samplesPerPixel).toBe(4);
      expect(cog.bitsPerSample).toBe(8);
      expect(cog.overviewCount).toBe(2);
      const rgba = await cog.readTileRgba(0, 0, 0);
      expect(rgba.length).toBe(256 * 256 * 4);
      expect(rgba[0]).toBe(expected.samples[0]!["0,0"]);
      const overview = await cog.readOverviewRgba(1);
      expect(overview.length).toBe(256 * 256 * 4);
      // Band-0 float reads still match the truth digest.
      const tile = await cog.readTile(0, 0, 0);
      expect(await tileDigest(tile)).toBe(expected.tileSha256[0]);
    } finally {
      cog.dispose();
    }
  });
});

describe("CogDataset — IO behaviour", () => {
  it("fails open with a typed range-not-supported error on HTTP 200", async () => {
    const fetch: RangeFetchLike = async () =>
      new Response(new Uint8Array(1 << 20), { status: 200 });
    const scheduler = new RangeScheduler({ fetch });
    await expect(
      CogDataset.open("https://example.test/dem.tif", { scheduler }),
    ).rejects.toMatchObject({
      code: "IO_ERROR",
      details: { reason: "range-not-supported" },
    });
    scheduler.dispose();
  });

  it("rejects a pre-aborted tile read", async () => {
    const cog = await CogDataset.open(
      await fixture("predictor-deflate-u16.tif"),
    );
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        cog.readTile(0, 0, 0, { signal: controller.signal }),
      ).rejects.toThrow();
      const stats = cog.stats();
      // The lookup registers a miss; the read aborted before fetch.
      expect(stats.cacheMisses).toBe(1);
    } finally {
      cog.dispose();
    }
  });

  it("rejects a cancelled tile read and aborts the fetch", async () => {
    const bytes = await readFile(`${GOLDEN}predictor-deflate-u16.tif`);
    const held: { signal: AbortSignal }[] = [];
    let hold = false;
    const fetch: RangeFetchLike = (_input, init) => {
      if (!hold) {
        const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
        const start = Number(match![1]);
        // Servers clamp the range end at EOF.
        const end = Math.min(Number(match![2]), bytes.length - 1);
        return Promise.resolve(
          new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-range": `bytes ${start}-${end}/${bytes.length}`,
            },
          }),
        );
      }
      const record = { signal: init.signal };
      held.push(record);
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    };
    const scheduler = new RangeScheduler({ fetch });
    const cog = await CogDataset.open(
      "https://example.test/predictor.tif",
      { scheduler },
    );
    hold = true;
    try {
      const controller = new AbortController();
      const read = cog.readTile(0, 0, 0, { signal: controller.signal });
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
      controller.abort();
      await expect(read).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      });
      expect(held.length).toBeGreaterThan(0);
      expect(held.every((call) => call.signal.aborted)).toBe(true);
    } finally {
      cog.dispose();
      scheduler.dispose();
    }
  });

  it("exposes the worker decode handler for pool registration", async () => {
    const handler = createCogWorkerHandler();
    // Compression 1 = none: decode returns the input bytes verbatim.
    const raw = new Uint8Array([1, 2, 3, 4]);
    const result = await handler(
      {
        compression: 1,
        parameters: {
          tileWidth: 2,
          tileHeight: 1,
          planarConfiguration: 1,
          bitsPerSample: [16],
          predictor: 1,
          samplesPerPixel: 1,
        },
        buffer: raw,
      },
      {} as never,
    );
    const data = (result as { data: ArrayBuffer }).data;
    expect(new Uint8Array(data)).toEqual(raw);
  });
});

describe("CogDataset — georeferencing and cache ownership", () => {
  async function writeTiff(metadata: Record<string, unknown>): Promise<Blob> {
    const { writeArrayBuffer } = await import("geotiff");
    const width = 4;
    const height = 4;
    const values = new Float32Array(width * height).map((_, i) => i);
    const buffer = writeArrayBuffer(values, {
      width,
      height,
      BitsPerSample: [32],
      SampleFormat: [3],
      ModelPixelScale: [2, 2, 0],
      ModelTiepoint: [0, 0, 0, 100, 200, 0],
      ...metadata,
    });
    return new Blob([buffer]);
  }

  it("reports no CRS for user-defined (32767) projected codes", async () => {
    const cog = await CogDataset.open(
      await writeTiff({ ProjectedCSTypeGeoKey: 32767, GTModelTypeGeoKey: 1 }),
    );
    try {
      expect(cog.crs).toBeNull();
    } finally {
      cog.dispose();
    }
  });

  it("reports no CRS for user-defined (32767) geographic codes", async () => {
    const cog = await CogDataset.open(
      await writeTiff({ GeographicTypeGeoKey: 32767, GTModelTypeGeoKey: 2 }),
    );
    try {
      expect(cog.crs).toBeNull();
    } finally {
      cog.dispose();
    }
  });

  it("keeps the origin of PixelIsArea rasters", async () => {
    const cog = await CogDataset.open(
      await writeTiff({ ProjectedCSTypeGeoKey: 32633, GTRasterTypeGeoKey: 1 }),
    );
    try {
      expect(cog.crs).toBe("EPSG:32633");
      expect(cog.geoTransform).toEqual([100, 2, 0, 200, 0, -2]);
      expect(cog.bounds).toEqual([100, 192, 108, 200]);
    } finally {
      cog.dispose();
    }
  });

  it("shifts PixelIsPoint origins by half a pixel like GDAL", async () => {
    const cog = await CogDataset.open(
      await writeTiff({ ProjectedCSTypeGeoKey: 32633, GTRasterTypeGeoKey: 2 }),
    );
    try {
      expect(cog.geoTransform).toEqual([99, 2, 0, 201, 0, -2]);
      expect(cog.bounds).toEqual([99, 193, 107, 201]);
    } finally {
      cog.dispose();
    }
  });

  it("returns a caller-owned copy on a cache miss", async () => {
    const expected = await truth("rainier-cog.json");
    const cog = await CogDataset.open(await fixture(expected.file));
    try {
      const first = await cog.readTile(0, 0, 0);
      const pristine = Array.from(first.slice(0, 8));
      first.fill(12345);
      const second = await cog.readTile(0, 0, 0);
      expect(Array.from(second.slice(0, 8))).toEqual(pristine);
      expect(second).not.toBe(first);
    } finally {
      cog.dispose();
    }
  });
});
