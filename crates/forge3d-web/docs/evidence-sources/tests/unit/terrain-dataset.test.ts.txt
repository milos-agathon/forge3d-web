import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Forge3DError,
  Forge3DWorkerPool,
  createTerrainDatasetWorkerHandler,
  getTerrainColormap,
  getTerrainColormapLut,
  serveForge3DMessagePort,
  TerrainDataset,
} from "../../src-ts/index.js";
import type {
  TerrainColorRampInput,
  TerrainSourceProgress,
} from "../../src-ts/index.js";

function expectReject(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

function expectThrow(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    expect((error as Forge3DError).code).toBe(code);
    return;
  }
  throw new Error("expected function to throw");
}

function f32le(values: number[]): ArrayBuffer {
  return new Float32Array(values).buffer as ArrayBuffer;
}

function planeDataset(
  width: number,
  height: number,
  spacing: [number, number] = [1, 1],
): TerrainDataset {
  const halfX = ((width - 1) * spacing[0]) / 2;
  const halfZ = ((height - 1) * spacing[1]) / 2;
  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const wx = x * spacing[0] - halfX;
      const wz = y * spacing[1] - halfZ;
      heights[y * width + x] = Math.fround(2 * wx + 3 * wz + 7);
    }
  }
  return TerrainDataset.fromArray({ width, height, heights, spacing });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerrainDataset.fromArray", () => {
  it("retains the input Float32Array and accounts bytes exactly", () => {
    const heights = new Float32Array([1, 2, 3, 4]);
    const dataset = TerrainDataset.fromArray({ width: 2, height: 2, heights });
    expect(dataset.heights).toBe(heights);
    expect(dataset.estimatedCpuBytes()).toBe(heights.byteLength);
    const mask = dataset.validMask();
    expect(mask.byteLength).toBe(4);
    expect(dataset.estimatedCpuBytes()).toBeLessThanOrEqual(
      heights.byteLength + 4,
    );
    expect(dataset.estimatedCpuBytes()).toBeLessThan(
      heights.byteLength + 4 * 4,
    );
  });

  it("computes statistics excluding NaN and explicit nodata", () => {
    const dataset = TerrainDataset.fromArray({
      width: 7,
      height: 1,
      heights: new Float32Array([0, 1, 2, 3, 4, NaN, -9999]),
      nodata: -9999,
    });
    const stats = dataset.statistics;
    expect(stats.count).toBe(5);
    expect(stats.nodataCount).toBe(2);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(4);
    expect(stats.mean).toBeCloseTo(2, 6);
    expect(stats.std).toBeCloseTo(Math.SQRT2, 6);
    expect(stats.median).toBeCloseTo(2, 6);
    expect(stats.p01).toBeCloseTo(0.04, 6);
    expect(stats.p99).toBeCloseTo(3.96, 6);
  });

  it("rejects invalid inputs with INVALID_INPUT", () => {
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 0,
          height: 2,
          heights: new Float32Array(0),
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 2,
          height: 2,
          heights: new Float32Array(3),
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 2,
          height: 1,
          heights: new Float32Array([NaN, NaN]),
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 2,
          height: 1,
          heights: new Float32Array([1, Infinity]),
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 2,
          height: 1,
          heights: new Float32Array([1, -Infinity]),
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 1,
          height: 1,
          heights: new Float32Array([1]),
          spacing: [0, 1],
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 1,
          height: 1,
          heights: new Float32Array([1]),
          spacing: [1, NaN],
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 1,
          height: 1,
          heights: new Float32Array([1]),
          domain: [5, 1],
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 1,
          height: 1,
          heights: new Float32Array([1]),
          exaggeration: -2,
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        TerrainDataset.fromArray({
          width: 1,
          height: 1,
          heights: new Float32Array([1]),
          crs: "",
        }),
      "INVALID_INPUT",
    );
  });

  it("applies defaults for spacing, exaggeration, domain and colormap", () => {
    const dataset = TerrainDataset.fromArray({
      width: 2,
      height: 2,
      heights: new Float32Array([1, 2, 3, 4]),
      crs: "EPSG:3857",
      transform: [1, 0, 0, 1, 0, 0],
      bounds: [0, 0, 10, 10],
    });
    expect(dataset.spacing).toEqual([1, 1]);
    expect(dataset.exaggeration).toBe(1);
    expect(dataset.domain).toEqual([1, 4]);
    expect(dataset.colormap).toBe("terrain");
    expect(dataset.crs).toBe("EPSG:3857");
    expect(dataset.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(dataset.bounds).toEqual([0, 0, 10, 10]);
  });

  it("expands a degenerate domain deterministically", () => {
    const dataset = TerrainDataset.fromArray({
      width: 1,
      height: 2,
      heights: new Float32Array([3, 3]),
    });
    expect(dataset.statistics.min).toBe(3);
    expect(dataset.statistics.max).toBe(3);
    expect(dataset.domain).toEqual([2.5, 3.5]);
  });

  it("computes exact order statistics for mixed float32 values", () => {
    const heights = new Float32Array([
      3.5, -2.25, 1e-45, 0, 2, 2, -0, 7.125, NaN,
    ]);
    const dataset = TerrainDataset.fromArray({
      width: 9,
      height: 1,
      heights,
    });
    const sorted = Array.from(heights)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const at = (q: number): number => {
      const position = (sorted.length - 1) * q;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      return (
        sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
      );
    };
    const stats = dataset.statistics;
    expect(stats.count).toBe(8);
    expect(stats.min).toBe(sorted[0]);
    expect(stats.max).toBe(sorted[7]);
    expect(stats.p01).toBeCloseTo(at(0.01), 6);
    expect(stats.median).toBeCloseTo(at(0.5), 6);
    expect(stats.p99).toBeCloseTo(at(0.99), 6);
  });
});

describe("TerrainDataset.normalize and fillNodata", () => {
  it("normalize returns a new dataset and does not mutate the source", () => {
    const heights = new Float32Array([0, 5, 10, NaN]);
    const dataset = TerrainDataset.fromArray({ width: 2, height: 2, heights });
    const normalized = dataset.normalize({
      domain: [0, 10],
      targetDomain: [0, 1],
    });
    expect(normalized).not.toBe(dataset);
    expect(normalized.heights).not.toBe(heights);
    expect(Array.from(heights.slice(0, 3))).toEqual([0, 5, 10]);
    expect(Number.isNaN(heights[3])).toBe(true);
    expect(normalized.heights[0]).toBeCloseTo(0, 6);
    expect(normalized.heights[1]).toBeCloseTo(0.5, 6);
    expect(normalized.heights[2]).toBeCloseTo(1, 6);
    expect(Number.isNaN(normalized.heights[3])).toBe(true);
    expect(normalized.domain).toEqual([0, 1]);
  });

  it("normalize clip clamps out-of-domain values", () => {
    const dataset = TerrainDataset.fromArray({
      width: 2,
      height: 1,
      heights: new Float32Array([-5, 15]),
    });
    const clipped = dataset.normalize({
      domain: [0, 10],
      targetDomain: [0, 1],
      clip: true,
    });
    expect(clipped.heights[0]).toBe(0);
    expect(clipped.heights[1]).toBe(1);
    const unclipped = dataset.normalize({
      domain: [0, 10],
      targetDomain: [0, 1],
    });
    expect(unclipped.heights[0]).toBeLessThan(0);
    expect(unclipped.heights[1]).toBeGreaterThan(1);
  });

  it("fillNodata nearest uses deterministic row-major tie-breaking", () => {
    const heights = new Float32Array([1, 7, 3, 4, NaN, 6, 7, 8, 9]);
    const dataset = TerrainDataset.fromArray({ width: 3, height: 3, heights });
    const filled = dataset.fillNodata("nearest");
    expect(filled.heights[4]).toBe(7);
    expect(Number.isNaN(heights[4])).toBe(true);
    const filledMean = dataset.fillNodata("mean");
    const expectedMean = (1 + 7 + 3 + 4 + 6 + 7 + 8 + 9) / 8;
    expect(filledMean.heights[4]).toBeCloseTo(expectedMean, 5);
  });
});

describe("TerrainDataset.fromSource", () => {
  it("decodes little-endian f32 from an ArrayBuffer with exact values", async () => {
    const dataset = await TerrainDataset.fromSource({
      width: 2,
      height: 2,
      source: f32le([1.5, -2.25, 3.125, 4.5]),
    });
    expect(Array.from(dataset.heights)).toEqual([1.5, -2.25, 3.125, 4.5]);
  });

  it("decodes a File source and reports progress ending done", async () => {
    const file = new File([f32le([1, 2, 3, 4])], "dem.bin");
    const progress: TerrainSourceProgress[] = [];
    const dataset = await TerrainDataset.fromSource({
      width: 2,
      height: 2,
      source: file,
      onProgress: (entry) => progress.push(entry),
    });
    expect(Array.from(dataset.heights)).toEqual([1, 2, 3, 4]);
    expect(progress[0]).toEqual({ loaded: 0, total: 16, done: false });
    expect(progress.at(-1)).toEqual({ loaded: 16, total: 16, done: true });
  });

  it("decodes a mocked URL source through fetch", async () => {
    const body = f32le([8, 7, 6, 5]);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(body.slice(0), {
          status: 200,
          headers: { "content-length": String(body.byteLength) },
        }),
    );
    const dataset = await TerrainDataset.fromSource({
      width: 2,
      height: 2,
      source: "https://example.test/dem.bin",
    });
    expect(Array.from(dataset.heights)).toEqual([8, 7, 6, 5]);
  });

  it("rejects wrong byte counts, cancellation, and maxBytes with exact codes", async () => {
    await expectReject(
      TerrainDataset.fromSource({
        width: 2,
        height: 2,
        source: new ArrayBuffer(12),
      }),
      "IO_ERROR",
    );
    const controller = new AbortController();
    controller.abort();
    await expectReject(
      TerrainDataset.fromSource({
        width: 2,
        height: 2,
        source: f32le([1, 2, 3, 4]),
        signal: controller.signal,
      }),
      "REQUEST_CANCELLED",
    );
    await expectReject(
      TerrainDataset.fromSource({
        width: 2,
        height: 2,
        source: f32le([1, 2, 3, 4]),
        maxBytes: 4,
      }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    let responseRef: Response | undefined;
    vi.stubGlobal("fetch", async () => {
      responseRef = new Response(f32le([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "64" },
      });
      return responseRef;
    });
    await expectReject(
      TerrainDataset.fromSource({
        width: 2,
        height: 2,
        source: "https://example.test/oversized.bin",
      }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
    expect(responseRef?.bodyUsed).toBe(false);
  });

  it("rejects an oversized body without Content-Length after reading", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new ArrayBuffer(24), {
          status: 200,
        }),
    );
    await expectReject(
      TerrainDataset.fromSource({
        width: 2,
        height: 2,
        source: "https://example.test/no-length.bin",
      }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
  });

  it("rejects an undersized body with IO_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new ArrayBuffer(12), {
          status: 200,
          headers: { "content-length": "12" },
        }),
    );
    await expectReject(
      TerrainDataset.fromSource({
        width: 2,
        height: 2,
        source: "https://example.test/undersized.bin",
      }),
      "IO_ERROR",
    );
  });
});

describe("TerrainDataset worker path", () => {
  it("round-trips through a real MessageChannel and transfers the buffer", async () => {
    const channel = new MessageChannel();
    const detach = serveForge3DMessagePort(channel.port2, {
      run: createTerrainDatasetWorkerHandler(),
    });
    try {
      const pool = new Forge3DWorkerPool({
        size: 1,
        workerFactory: () => channel.port1,
        mainThreadHandler: createTerrainDatasetWorkerHandler(),
      });
      try {
        const source = f32le([10, 20, 30, 40]);
        const dataset = await TerrainDataset.fromSource(
          {
            width: 2,
            height: 2,
            source,
          },
          { workerPool: pool },
        );
        expect(Array.from(dataset.heights)).toEqual([10, 20, 30, 40]);
      } finally {
        pool.dispose();
      }
    } finally {
      detach();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("transfers the payload buffer into the handler and back", async () => {
    const channel = new MessageChannel();
    const detach = serveForge3DMessagePort(channel.port2, {
      run: createTerrainDatasetWorkerHandler(),
    });
    try {
      const pool = new Forge3DWorkerPool({
        size: 1,
        workerFactory: () => channel.port1,
        mainThreadHandler: createTerrainDatasetWorkerHandler(),
      });
      try {
        const buffer = f32le([1.25, 2.5, 3.75, 5]);
        const heights = new Float32Array(buffer);
        const result = await pool.run<Float32Array>(
          { width: 2, height: 2, heights },
          { transfer: [buffer] },
        );
        expect(buffer.byteLength).toBe(0);
        expect(Array.from(result)).toEqual([1.25, 2.5, 3.75, 5]);
      } finally {
        pool.dispose();
      }
    } finally {
      detach();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("sends an ArrayBuffer payload, not a prebuilt heights view", async () => {
    const channel = new MessageChannel();
    const postSpy = vi.spyOn(channel.port1, "postMessage");
    const detach = serveForge3DMessagePort(channel.port2, {
      run: createTerrainDatasetWorkerHandler(),
    });
    try {
      const pool = new Forge3DWorkerPool({
        size: 1,
        workerFactory: () => channel.port1,
        mainThreadHandler: createTerrainDatasetWorkerHandler(),
      });
      try {
        const dataset = await TerrainDataset.fromSource(
          {
            width: 2,
            height: 2,
            source: f32le([3, 1, 4, 1]),
          },
          { workerPool: pool },
        );
        expect(Array.from(dataset.heights)).toEqual([3, 1, 4, 1]);
        const call = postSpy.mock.calls.find(
          ([envelope]) =>
            typeof envelope === "object" &&
            envelope !== null &&
            (envelope as { type?: unknown }).type === "call",
        );
        expect(call).toBeDefined();
        const envelope = call![0] as {
          payload: { buffer?: unknown; heights?: unknown };
        };
        expect(envelope.payload.buffer).toBeInstanceOf(ArrayBuffer);
        expect(envelope.payload.heights).toBeUndefined();
        const transfer = call![1] as Transferable[];
        expect(transfer[0]).toBe(envelope.payload.buffer);
        expect((transfer[0] as ArrayBuffer).byteLength).toBe(0);
      } finally {
        pool.dispose();
      }
    } finally {
      detach();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("runs the handler on the main thread when no factory is provided", async () => {
    const pool = new Forge3DWorkerPool({
      size: 1,
      mainThreadHandler: createTerrainDatasetWorkerHandler(),
    });
    try {
      const result = await pool.run<Float32Array>({
        width: 2,
        height: 2,
        heights: new Float32Array([9, 8, 7, 6]),
      });
      expect(Array.from(result)).toEqual([9, 8, 7, 6]);
    } finally {
      pool.dispose();
    }
  });
});

describe("TerrainDataset slope/aspect and query", () => {
  it("matches the analytic plane slope and aspect", () => {
    const dataset = planeDataset(5, 5);
    const { slopeRadians, aspectRadians } = dataset.slopeAspect();
    const expectedSlope = Math.atan(Math.sqrt(13));
    const expectedAspect = Math.atan2(-2, -3) + Math.PI * 2;
    for (let index = 0; index < slopeRadians.length; index += 1) {
      expect(Math.abs(slopeRadians[index]! - expectedSlope)).toBeLessThan(1e-4);
      expect(Math.abs(aspectRadians[index]! - expectedAspect)).toBeLessThan(
        1e-4,
      );
    }
  });

  it("returns deterministic single-axis gradients", () => {
    const single = TerrainDataset.fromArray({
      width: 1,
      height: 1,
      heights: new Float32Array([5]),
    });
    const singleResult = single.slopeAspect();
    expect(singleResult.slopeRadians[0]).toBe(0);
    expect(singleResult.aspectRadians[0]).toBe(0);

    const column = TerrainDataset.fromArray({
      width: 1,
      height: 3,
      heights: new Float32Array([0, 3, 9]),
      spacing: [1, 2],
    });
    const columnResult = column.slopeAspect();
    for (const value of columnResult.slopeRadians) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(columnResult.slopeRadians[1]).toBeCloseTo(Math.atan(2.25), 6);
    expect(columnResult.aspectRadians[1]).toBeCloseTo(Math.PI, 6);
  });

  it("returns NaN slope/aspect at invalid cells and finite neighbors", () => {
    const heights = new Float32Array(25).fill(1);
    heights[12] = NaN;
    const dataset = TerrainDataset.fromArray({ width: 5, height: 5, heights });
    const { slopeRadians, aspectRadians } = dataset.slopeAspect();
    expect(Number.isNaN(slopeRadians[12])).toBe(true);
    expect(Number.isNaN(aspectRadians[12])).toBe(true);
    expect(Number.isFinite(slopeRadians[11])).toBe(true);
    expect(Number.isFinite(slopeRadians[13])).toBe(true);
    expect(Number.isFinite(slopeRadians[7])).toBe(true);
    expect(Number.isFinite(slopeRadians[17])).toBe(true);
  });

  it("bilinearly interpolates plane elevation and reports grid position", () => {
    const dataset = planeDataset(5, 5);
    const sample = dataset.query(0.25, -0.5);
    expect(sample).toBeDefined();
    const expectedElevation = 2 * 0.25 + 3 * -0.5 + 7;
    expect(sample!.elevation).toBeCloseTo(expectedElevation, 6);
    expect(sample!.slopeRadians).toBeCloseTo(Math.atan(Math.sqrt(13)), 4);
    expect(sample!.aspectRadians).toBeCloseTo(
      Math.atan2(-2, -3) + Math.PI * 2,
      4,
    );
    const normalLength = Math.hypot(...sample!.normal);
    expect(normalLength).toBeCloseTo(1, 6);
    expect(sample!.gridPosition[0]).toBeCloseTo(2.25, 6);
    expect(sample!.gridPosition[1]).toBeCloseTo(1.5, 6);
    expect(dataset.query(-100, 0)).toBeUndefined();
    expect(dataset.query(0, 100)).toBeUndefined();
  });

  it("returns NaN results when the bilinear footprint touches nodata", () => {
    const heights = new Float32Array([1, 1, 1, 1, NaN, 1, 1, 1, 1]);
    const dataset = TerrainDataset.fromArray({ width: 3, height: 3, heights });
    const sample = dataset.query(0.5, 0.5);
    expect(sample).toBeDefined();
    expect(Number.isNaN(sample!.elevation)).toBe(true);
  });
});

describe("TerrainDataset contours", () => {
  it("resolves saddle cells with the asymptotic determinant", () => {
    const saddle = (heights: number[]): TerrainDataset =>
      TerrainDataset.fromArray({
        width: 2,
        height: 2,
        heights: new Float32Array(heights),
        spacing: [1, 1],
      });
    const segments = (input: TerrainDataset): number[][] =>
      input.contours([1]).polylines.map((polyline) => [
        polyline.points[0]!,
        polyline.points[1]!,
        polyline.points[2]!,
        polyline.points[3]!,
      ]);

    expect(segments(saddle([2, 0, 0, 4]))).toEqual([
      [0, -0.5, 0.5, -0.25],
      [-0.5, 0, -0.25, 0.5],
    ]);

    expect(segments(saddle([-2, 2, 2, -2]))).toEqual([
      [0.25, -0.5, 0.5, -0.25],
      [-0.5, 0.25, -0.25, 0.5],
    ]);

    const negative = segments(saddle([2, -1, -1, 2]));
    expect(negative[0]![0]).toBeCloseTo(-0.5, 6);
    expect(negative[0]![1]).toBeCloseTo(-1 / 6, 5);
    expect(negative[0]![2]).toBeCloseTo(-1 / 6, 5);
    expect(negative[0]![3]).toBeCloseTo(-0.5, 6);
    expect(negative[1]![0]).toBeCloseTo(0.5, 6);
    expect(negative[1]![1]).toBeCloseTo(1 / 6, 5);
    expect(negative[1]![2]).toBeCloseTo(1 / 6, 5);
    expect(negative[1]![3]).toBeCloseTo(0.5, 6);

    const caseTenNegative = segments(saddle([0, 2, 4, 0]));
    expect(caseTenNegative).toEqual([
      [-0.5, -0.25, 0, -0.5],
      [0.5, 0, 0.25, 0.5],
    ]);
  });

  it("follows the analytic level line of a linear ramp within 0.25 cell", () => {
    const width = 6;
    const height = 4;
    const heights = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        heights[y * width + x] = x;
      }
    }
    const dataset = TerrainDataset.fromArray({ width, height, heights });
    const result = dataset.contours([2.5]);
    expect(result.polylineCount).toBeGreaterThan(0);
    for (const polyline of result.polylines) {
      expect(polyline.level).toBe(2.5);
      for (let i = 0; i < polyline.points.length; i += 2) {
        expect(Math.abs(polyline.points[i]!)).toBeLessThanOrEqual(0.25);
      }
    }
  });

  it("rejects empty and non-finite level lists", () => {
    const dataset = TerrainDataset.fromArray({
      width: 3,
      height: 3,
      heights: new Float32Array(9).fill(1),
    });
    expectThrow(() => dataset.contours([]), "INVALID_INPUT");
    expectThrow(() => dataset.contours([NaN]), "INVALID_INPUT");
    expectThrow(() => dataset.contours([Infinity]), "INVALID_INPUT");
  });
});

describe("TerrainDataset AO and sun visibility", () => {
  function flatField(): TerrainDataset {
    return TerrainDataset.fromArray({
      width: 9,
      height: 9,
      heights: new Float32Array(81).fill(0),
      spacing: [1, 1],
    });
  }

  function ridgeDataset(): TerrainDataset {
    const width = 9;
    const height = 9;
    const heights = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        heights[y * width + x] = x === 4 ? 6 : 0;
      }
    }
    return TerrainDataset.fromArray({ width, height, heights });
  }

  it("returns 1 for flat terrain and below 0.98 inside occluded valleys", () => {
    const ao = flatField().heightAo({
      enabled: true,
      resolutionScale: 1,
      directions: 8,
      steps: 16,
      maxDistance: 8,
      strength: 1,
    });
    expect(ao.kind).toBe("height-ao");
    expect(ao.width).toBe(9);
    expect(ao.height).toBe(9);
    for (const value of ao.values) {
      expect(value).toBeCloseTo(1, 5);
    }

    const occluded = ridgeDataset().heightAo({
      enabled: true,
      resolutionScale: 1,
      directions: 8,
      steps: 16,
      maxDistance: 8,
      strength: 1,
    });
    expect(Math.min(...occluded.values)).toBeLessThan(0.98);
  });

  it("returns all 1 when disabled", () => {
    const ao = ridgeDataset().heightAo({ enabled: false });
    for (const value of ao.values) {
      expect(value).toBe(1);
    }
  });

  it("hard sun ignores samples/softness and shadows behind a ridge", () => {
    const flat = flatField().sunVisibility({
      enabled: true,
      mode: "hard",
      resolutionScale: 1,
      samples: 9,
      steps: 16,
      maxDistance: 8,
      softness: 2,
      bias: 0.001,
      direction: [1, 0.5, 0],
    });
    for (const value of flat.values) {
      expect(value).toBe(1);
    }
    const shaded = ridgeDataset().sunVisibility({
      enabled: true,
      mode: "hard",
      resolutionScale: 1,
      samples: 9,
      steps: 16,
      maxDistance: 8,
      softness: 2,
      bias: 0.001,
      direction: [1, 0.5, 0],
    });
    expect(Math.min(...shaded.values)).toBe(0);
  });

  it("validates AO and sun option ranges", () => {
    const dataset = flatField();
    expectThrow(
      () => dataset.heightAo({ resolutionScale: 0.05 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.heightAo({ resolutionScale: 1.5 }),
      "INVALID_INPUT",
    );
    expectThrow(() => dataset.heightAo({ directions: 0 }), "INVALID_INPUT");
    expectThrow(() => dataset.heightAo({ directions: 17 }), "INVALID_INPUT");
    expectThrow(() => dataset.heightAo({ steps: 0 }), "INVALID_INPUT");
    expectThrow(() => dataset.heightAo({ steps: 65 }), "INVALID_INPUT");
    expectThrow(() => dataset.heightAo({ maxDistance: 0 }), "INVALID_INPUT");
    expectThrow(
      () => dataset.heightAo({ maxDistance: NaN }),
      "INVALID_INPUT",
    );
    expectThrow(() => dataset.heightAo({ strength: -0.1 }), "INVALID_INPUT");
    expectThrow(() => dataset.heightAo({ strength: 3 }), "INVALID_INPUT");
    expectThrow(
      () => dataset.sunVisibility({ mode: "soft", samples: 0 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ mode: "soft", samples: 17 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ mode: "soft", softness: -1 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ mode: "hard", samples: 0 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ mode: "hard", samples: 17 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ mode: "hard", softness: -1 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ samples: 0 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ steps: 0 }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ maxDistance: -1 }),
      "INVALID_INPUT",
    );
    expectThrow(() => dataset.sunVisibility({ bias: -1 }), "INVALID_INPUT");
    expectThrow(
      () => dataset.sunVisibility({ direction: [0, 0, 0] }),
      "INVALID_INPUT",
    );
    expectThrow(
      () => dataset.sunVisibility({ direction: [1, NaN, 0] }),
      "INVALID_INPUT",
    );
  });
});

describe("terrain colormaps", () => {
  const endpoints: Record<
    string,
    { first: [number, number, number]; last: [number, number, number] }
  > = {
    viridis: { first: [68, 1, 84], last: [253, 231, 37] },
    magma: { first: [0, 0, 4], last: [252, 253, 191] },
    terrain: { first: [199, 208, 177], last: [116, 94, 55] },
    grayscale: { first: [0, 0, 0], last: [255, 255, 255] },
  };

  for (const name of Object.keys(endpoints) as Array<keyof typeof endpoints>) {
    it(`produces a 256*4 RGBA LUT for ${name}`, () => {
      const lut = getTerrainColormapLut(name);
      expect(lut.byteLength).toBe(256 * 4);
      expect(lut[3]).toBe(255);
      expect(lut[255 * 4 + 3]).toBe(255);
      const { first, last } = endpoints[name];
      expect([lut[0], lut[1], lut[2]]).toEqual(first);
      expect([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]]).toEqual(last);
    });
  }

  it("returns copies of named ramps", () => {
    const ramp: TerrainColorRampInput = getTerrainColormap("viridis");
    expect(ramp.stops.length).toBe(8);
    ramp.stops[0]!.position = 0.9;
    expect(getTerrainColormap("viridis").stops[0]!.position).toBe(0);
  });

  it("rejects invalid colormap inputs", () => {
    expectThrow(
      () => getTerrainColormap("nope" as never),
      "INVALID_INPUT",
    );
    expectThrow(() => getTerrainColormapLut("viridis", 1), "INVALID_INPUT");
    expectThrow(() => getTerrainColormapLut("viridis", 2.5), "INVALID_INPUT");
    expectThrow(
      () =>
        getTerrainColormapLut("nope" as never),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        getTerrainColormapLut({
          stops: [{ position: 0, color: [0, 0, 0] }],
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        getTerrainColormapLut({
          stops: [
            { position: 0.5, color: [0, 0, 0] },
            { position: 0.25, color: [1, 1, 1] },
          ],
        }),
      "INVALID_INPUT",
    );
    expectThrow(
      () =>
        getTerrainColormapLut({
          stops: [
            { position: 0, color: [0, 0, 2] },
            { position: 1, color: [1, 1, 1] },
          ],
        }),
      "INVALID_INPUT",
    );
  });
});
