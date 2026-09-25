import { afterEach, describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  IblPrecomputedSnapshot,
  IblPrecomputeTarget,
  IblQuality,
  IblSnapshot,
} from "../../src-ts/index.js";
import {
  decodeRgbe,
  iblFromSnapshot,
  iblPreparedLengths,
  IblCache,
  ImageBasedLighting,
} from "../../src-ts/ibl.js";

function expectCode(factory: () => unknown, code: string): Forge3DError {
  try {
    factory();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    expect((error as Forge3DError).code).toBe(code);
    return error as Forge3DError;
  }
  throw new Error("expected Forge3DError");
}

async function expectCodeAsync(
  factory: () => Promise<unknown>,
  code: string,
): Promise<Forge3DError> {
  try {
    await factory();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    expect((error as Forge3DError).code).toBe(code);
    return error as Forge3DError;
  }
  throw new Error("expected Forge3DError");
}

function encodeRgbe(
  width: number,
  height: number,
  pixels: Uint8Array,
  options: { xSign?: "+" | "-"; ySign?: "+" | "-"; crlf?: boolean } = {},
): Uint8Array {
  const newline = options.crlf === true ? "\r\n" : "\n";
  const header = `#?RADIANCE${newline}FORMAT=32-bit_rle_rgbe${newline}${newline}${options.ySign ?? "-"}Y ${height} ${options.xSign ?? "+"}X ${width}${newline}`;
  const head = new TextEncoder().encode(header);
  const parts: number[] = [];
  const useRle = width >= 8 && width <= 32767;
  for (let row = 0; row < height; row += 1) {
    if (!useRle) {
      for (let x = 0; x < width; x += 1) {
        const base = (row * width + x) * 4;
        parts.push(
          pixels[base]!,
          pixels[base + 1]!,
          pixels[base + 2]!,
          pixels[base + 3]!,
        );
      }
      continue;
    }
    parts.push(2, 2, (width >> 8) & 0xff, width & 0xff);
    for (let channel = 0; channel < 4; channel += 1) {
      let x = 0;
      while (x < width) {
        const value = pixels[(row * width + x) * 4 + channel]!;
        let run = 1;
        while (
          x + run < width &&
          run < 127 &&
          pixels[(row * width + x + run) * 4 + channel] === value
        ) {
          run += 1;
        }
        if (run >= 2) {
          parts.push(128 + run, value);
          x += run;
        } else {
          const start = x;
          x += 1;
          while (
            x < width &&
            x - start < 127 &&
            !(
              x + 1 < width &&
              pixels[(row * width + x) * 4 + channel] ===
                pixels[(row * width + x + 1) * 4 + channel]
            )
          ) {
            x += 1;
          }
          parts.push(x - start);
          for (let index = start; index < x; index += 1) {
            parts.push(pixels[(row * width + index) * 4 + channel]!);
          }
        }
      }
    }
  }
  const out = new Uint8Array(head.length + parts.length);
  out.set(head, 0);
  out.set(Uint8Array.from(parts), head.length);
  return out;
}

function linearImage(width = 4, height = 2) {
  const data = new Float32Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 0.25;
    data[index + 1] = 0.5;
    data[index + 2] = 1.5;
    data[index + 3] = 1;
  }
  return { width, height, data };
}

const QUALITY_SIZES: Record<
  IblQuality,
  {
    irradianceSize: number;
    specularSize: number;
    specularMipCount: number;
    brdfLutSize: number;
  }
> = {
  // Native IBLQuality tiers (1f4084a:src/core/ibl.rs).
  low: { irradianceSize: 64, specularSize: 128, specularMipCount: 5, brdfLutSize: 512 },
  medium: {
    irradianceSize: 128,
    specularSize: 256,
    specularMipCount: 6,
    brdfLutSize: 512,
  },
  high: {
    irradianceSize: 256,
    specularSize: 512,
    specularMipCount: 7,
    brdfLutSize: 512,
  },
  ultra: {
    irradianceSize: 256,
    specularSize: 1024,
    specularMipCount: 8,
    brdfLutSize: 512,
  },
};

function preparedPayload(quality: IblQuality): IblPrecomputedSnapshot {
  const lengths = iblPreparedLengths(quality);
  const sizes = QUALITY_SIZES[quality];
  const fill = (length: number, seed: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index + seed) & 0xff;
    }
    return bytes;
  };
  return {
    format: "rgba16float",
    irradianceSize: sizes.irradianceSize,
    specularSize: sizes.specularSize,
    specularMipCount: sizes.specularMipCount,
    brdfLutSize: sizes.brdfLutSize,
    irradiance: fill(lengths.irradiance, 1),
    specular: fill(lengths.specular, 7),
    brdfLut: fill(lengths.brdfLut, 13),
  };
}

function preparedSnapshotFor(ibl: ImageBasedLighting): IblSnapshot {
  const snapshot = ibl.snapshot();
  return {
    ...snapshot,
    effectiveQuality: snapshot.requestedQuality,
    prepared: preparedPayload(snapshot.requestedQuality),
    report: {
      ...snapshot.report,
      effectiveQuality: snapshot.requestedQuality,
      effectiveMode: "prepared-upload",
      reason: "prepared by fake target",
    },
  };
}

describe("decodeRgbe", () => {
  it("decodes flat pixels for widths below the RLE threshold", () => {
    const pixels = new Uint8Array([128, 64, 32, 129, 0, 0, 0, 0]);
    const image = decodeRgbe(encodeRgbe(2, 1, pixels));
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect(image.data).toHaveLength(8);
    expect(image.data[0]).toBeCloseTo(1);
    expect(image.data[1]).toBeCloseTo(0.5);
    expect(image.data[2]).toBeCloseTo(0.25);
    expect(image.data[3]).toBe(1);
    expect(image.data[4]).toBe(0);
    expect(image.data[7]).toBe(1);
  });

  it("preserves HDR values above one", () => {
    const pixels = new Uint8Array([200, 100, 50, 140]);
    const image = decodeRgbe(encodeRgbe(2, 1, new Uint8Array([...pixels, ...pixels])));
    expect(image.data[0]).toBeCloseTo((200 * 2 ** (140 - 136)) as number, 5);
    expect(image.data[0]).toBeGreaterThan(1);
  });

  it("accepts #?RGBE magic and CRLF headers", () => {
    const pixels = new Uint8Array([255, 255, 255, 129, 255, 255, 255, 129]);
    const crlf = `#?RGBE\r\nFORMAT=32-bit_rle_rgbe\r\n\r\n-Y 1 +X 2\r\n`;
    const head = new TextEncoder().encode(crlf);
    const bytes = new Uint8Array(head.length + 8);
    bytes.set(head, 0);
    bytes.set(pixels, head.length);
    const image = decodeRgbe(bytes);
    expect(image.data[0]).toBeCloseTo(255 / 128, 5);
  });

  it("decodes modern RLE scanlines with mixed runs and literals", () => {
    const width = 8;
    const pixels = new Uint8Array(width * 4);
    for (let x = 0; x < width; x += 1) {
      const base = x * 4;
      pixels[base] = x < 4 ? 200 : x * 10;
      pixels[base + 1] = 100;
      pixels[base + 2] = x;
      pixels[base + 3] = 129;
    }
    const image = decodeRgbe(encodeRgbe(width, 1, pixels));
    for (let x = 0; x < width; x += 1) {
      const expected = pixels[x * 4]! / 128;
      expect(image.data[x * 4]!).toBeCloseTo(expected, 5);
      expect(image.data[x * 4 + 1]!).toBeCloseTo(100 / 128, 5);
      expect(image.data[x * 4 + 2]!).toBeCloseTo(x / 128, 5);
      expect(image.data[x * 4 + 3]).toBe(1);
    }
  });

  it("reorients all axis-sign combinations to canonical output", () => {
    const pixels = new Uint8Array([
      10, 0, 0, 129, 20, 0, 0, 129,
      30, 0, 0, 129, 40, 0, 0, 129,
    ]);
    const expected = decodeRgbe(encodeRgbe(2, 2, pixels));
    for (const ySign of ["-", "+"] as const) {
      for (const xSign of ["+", "-"] as const) {
        const stored = new Uint8Array(16);
        for (let row = 0; row < 2; row += 1) {
          for (let x = 0; x < 2; x += 1) {
            const fileRow = ySign === "-" ? row : 1 - row;
            const fileX = xSign === "+" ? x : 1 - x;
            stored.set(
              pixels.subarray((row * 2 + x) * 4, (row * 2 + x) * 4 + 4),
              (fileRow * 2 + fileX) * 4,
            );
          }
        }
        const image = decodeRgbe(
          encodeRgbe(2, 2, stored, { ySign, xSign }),
        );
        expect(Array.from(image.data)).toEqual(Array.from(expected.data));
      }
    }
  });

  it("rejects malformed inputs", () => {
    expectCode(() => decodeRgbe(new Uint8Array(0)), "INVALID_INPUT");
    expectCode(
      () => decodeRgbe(new TextEncoder().encode("hello world\n")),
      "INVALID_INPUT",
    );
    const noFormat = new TextEncoder().encode("#?RADIANCE\n\n-Y 1 +X 1\n");
    expectCode(() => decodeRgbe(noFormat), "INVALID_INPUT");
    const badFormat = new TextEncoder().encode(
      "#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n",
    );
    expectCode(() => decodeRgbe(badFormat), "INVALID_INPUT");
    const badResolution = new TextEncoder().encode(
      "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\nX 1 Y 1\n",
    );
    expectCode(() => decodeRgbe(badResolution), "INVALID_INPUT");
    const truncatedFlat = new Uint8Array(
      new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n")
        .length + 4,
    );
    truncatedFlat.set(
      new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n"),
    );
    expectCode(() => decodeRgbe(truncatedFlat), "INVALID_INPUT");
  });

  it("decodes old flat scanlines at RLE-eligible width", () => {
    const header = new TextEncoder().encode(
      "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 8\n",
    );
    const pixels = new Uint8Array(16 * 4);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const base = (y * 8 + x) * 4;
        pixels[base] = x * 36;
        pixels[base + 1] = y * 85;
        pixels[base + 2] = 128;
        pixels[base + 3] = 128;
      }
    }
    const bytes = new Uint8Array(header.length + pixels.length);
    bytes.set(header);
    bytes.set(pixels, header.length);
    const image = decodeRgbe(bytes);
    expect(image.width).toBe(8);
    expect(image.height).toBe(2);
    const scale = 2 ** (128 - 136);
    for (let x = 0; x < 8; x += 1) {
      expect(image.data[x * 4]!).toBeCloseTo(x * 36 * scale, 6);
      expect(image.data[x * 4 + 2]!).toBeCloseTo(128 * scale, 6);
      expect(image.data[(8 + x) * 4 + 1]!).toBeCloseTo(85 * scale, 6);
    }
  });

  it("rejects a two-two marker with the wrong declared width", () => {
    const wrongWidth = Uint8Array.from([
      ...new TextEncoder().encode(
        "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n",
      ),
      2, 2, 0, 9,
      129, 7,
    ]);
    expectCode(() => decodeRgbe(wrongWidth), "INVALID_INPUT");
  });

  it("rejects RLE protocol violations", () => {
    const pixels = new Uint8Array(8 * 4).fill(200);
    pixels[3] = 129;
    for (let x = 0; x < 8; x += 1) {
      pixels[x * 4 + 3] = 129;
    }
    const good = encodeRgbe(8, 1, pixels);
    decodeRgbe(good);

    const headLength = new TextEncoder().encode(
      "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n",
    ).length;
    const truncated = good.slice(0, headLength + 6);
    expectCode(() => decodeRgbe(truncated), "INVALID_INPUT");

    const zeroRun = Uint8Array.from([
      ...new TextEncoder().encode(
        "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n",
      ),
      2, 2, 0, 8,
      0,
    ]);
    expectCode(() => decodeRgbe(zeroRun), "INVALID_INPUT");

    const overflow = Uint8Array.from([
      ...new TextEncoder().encode(
        "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n",
      ),
      2, 2, 0, 8,
      128 + 9, 5,
    ]);
    expectCode(() => decodeRgbe(overflow), "INVALID_INPUT");

    const badMarker = Uint8Array.from([
      ...new TextEncoder().encode(
        "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n",
      ),
      1, 1, 0, 8,
    ]);
    expectCode(() => decodeRgbe(badMarker), "INVALID_INPUT");
  });

  it("enforces the dimension limit and trailing-data rules", () => {
    const tooBig = new TextEncoder().encode(
      "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 20000\n",
    );
    expectCode(() => decodeRgbe(tooBig), "RESOURCE_LIMIT_EXCEEDED");
    const pixels = new Uint8Array([128, 64, 32, 129]);
    const withWhitespace = Uint8Array.from([
      ...encodeRgbe(1, 1, pixels),
      0x20, 0x0a,
    ]);
    decodeRgbe(withWhitespace);
    const withJunk = Uint8Array.from([...encodeRgbe(1, 1, pixels), 0x41]);
    expectCode(() => decodeRgbe(withJunk), "INVALID_INPUT");
  });
});

describe("iblPreparedLengths", () => {
  it("matches the published quality table", () => {
    const specularSum = (size: number, mips: number) => {
      let total = 0;
      for (let mip = 0; mip < mips; mip += 1) {
        const mipSize = Math.max(1, size >> mip);
        total += mipSize * mipSize * 6 * 8;
      }
      return total;
    };
    for (const quality of ["low", "medium", "high", "ultra"] as const) {
      const sizes = QUALITY_SIZES[quality];
      expect(iblPreparedLengths(quality)).toEqual({
        irradiance: sizes.irradianceSize * sizes.irradianceSize * 6 * 8,
        specular: specularSum(sizes.specularSize, sizes.specularMipCount),
        brdfLut: sizes.brdfLutSize * sizes.brdfLutSize * 8,
      });
    }
  });
});

describe("ImageBasedLighting", () => {
  it("creates from linear data with defensive copies", async () => {
    const source = linearImage();
    const ibl = await ImageBasedLighting.fromLinear(source);
    source.data[0] = 999;
    const snapshot = ibl.snapshot();
    expect(snapshot.source.data[0]).toBe(0.25);
    expect(snapshot.intensity).toBe(1);
    expect(snapshot.rotationDegrees).toBe(0);
    expect(snapshot.requestedQuality).toBe("medium");
    expect(snapshot.source.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ibl.prepared).toBe(false);
    const report = ibl.report;
    expect(report.effectiveMode).toBe("runtime-precompute");
    expect(report.cacheHit).toBe(false);
    expect(report.cacheBackend).toBe("none");
    expect(report.effectiveQuality).toBe("medium");
    expect(report.brdfApproximation).toBe("split-sum-ggx");
    expect(report.reason).toBe("not prepared");
  });

  it("validates source shape, intensity, rotation, and quality", async () => {
    await expectCodeAsync(
      () =>
        ImageBasedLighting.fromLinear({
          width: 2,
          height: 2,
          data: new Float32Array(4),
        }),
      "INVALID_INPUT",
    );
    const nonFinite = linearImage();
    nonFinite.data[1] = Number.NaN;
    await expectCodeAsync(
      () => ImageBasedLighting.fromLinear(nonFinite),
      "INVALID_INPUT",
    );
    await expectCodeAsync(
      () => ImageBasedLighting.fromLinear({ width: 0, height: 1, data: new Float32Array(4) }),
      "INVALID_INPUT",
    );
    await expectCodeAsync(
      () =>
        ImageBasedLighting.fromLinear({
          width: 20000,
          height: 1,
          data: new Float32Array(20000 * 4),
        }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
    await expectCodeAsync(
      () => ImageBasedLighting.fromLinear(linearImage(), { intensity: -1 }),
      "INVALID_INPUT",
    );
    await expectCodeAsync(
      () => ImageBasedLighting.fromLinear(linearImage(), { intensity: Number.NaN }),
      "INVALID_INPUT",
    );
    await expectCodeAsync(
      () =>
        ImageBasedLighting.fromLinear(linearImage(), {
          rotationDegrees: Number.POSITIVE_INFINITY,
        }),
      "INVALID_INPUT",
    );
    await expectCodeAsync(
      () =>
        ImageBasedLighting.fromLinear(linearImage(), {
          quality: "extreme" as IblQuality,
        }),
      "INVALID_INPUT",
    );
  });

  it("normalizes rotation into [0, 360)", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      rotationDegrees: -90,
    });
    expect(ibl.snapshot().rotationDegrees).toBe(270);
    const wrapped = await ImageBasedLighting.fromLinear(linearImage(), {
      rotationDegrees: 450,
    });
    expect(wrapped.snapshot().rotationDegrees).toBe(90);
  });

  it("decodes RGBE byte sources", async () => {
    const pixels = new Uint8Array([128, 64, 32, 129, 200, 100, 50, 140]);
    const ibl = await ImageBasedLighting.fromRGBE(
      encodeRgbe(2, 1, pixels),
      { quality: "low", intensity: 0.5 },
    );
    const snapshot = ibl.snapshot();
    expect(snapshot.source.width).toBe(2);
    expect(snapshot.source.height).toBe(1);
    expect(snapshot.intensity).toBe(0.5);
    expect(snapshot.requestedQuality).toBe("low");
  });

  it("matches the lead-checked SHA-256 literals", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    expect(ibl.snapshot().source.sourceHash).toBe(
      "00e32d439691524eb55fe3bd0a91db7dbdd9e5d8d7871de16e60a384d2bcabdf",
    );
    // Cache schema v2 (native IBL port) plus the prefilter lane (per-mip = 1).
    expect(await ibl.cacheKey()).toBe(
      "b37cb04996139cd9c45a9ba6439cced486097cad937f28fa4101921f9324d212",
    );
  });

  it("defaults to the per-mip prefilter and keys the native schedule separately", async () => {
    const perMip = await ImageBasedLighting.fromLinear(linearImage(), { quality: "low" });
    expect(perMip.prefilter).toBe("per-mip");
    expect(perMip.snapshot().prefilter).toBe("per-mip");
    const native = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
      prefilter: "native",
    });
    expect(native.prefilter).toBe("native");
    expect(await native.cacheKey()).not.toBe(await perMip.cacheKey());
    expect(iblFromSnapshot(native.snapshot()).prefilter).toBe("native");
    await expectCodeAsync(
      () =>
        ImageBasedLighting.fromLinear(linearImage(), {
          quality: "low",
          prefilter: "fast" as never,
        }),
      "INVALID_INPUT",
    );
  });

  it("produces deterministic cache keys that vary with settings", async () => {
    const base = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const same = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const brighter = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
      intensity: 2,
    });
    const rotated = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
      rotationDegrees: 45,
    });
    const quality = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "high",
    });
    const key = await base.cacheKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await same.cacheKey()).toBe(key);
    expect(await brighter.cacheKey()).not.toBe(key);
    expect(await rotated.cacheKey()).not.toBe(key);
    expect(await quality.cacheKey()).not.toBe(key);
  });

  it("prepares through a precompute target and leaves the original untouched", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const calls: IblSnapshot[] = [];
    const target: IblPrecomputeTarget = {
      precomputeIbl: (input) => {
        calls.push(input);
        return Promise.resolve(preparedSnapshotFor(ibl));
      },
    };
    const prepared = await ibl.prepare(target);
    expect(calls).toHaveLength(1);
    expect(prepared).not.toBe(ibl);
    expect(ibl.prepared).toBe(false);
    expect(prepared.prepared).toBe(true);
    const report = prepared.report;
    expect(report.effectiveMode).toBe("prepared-upload");
    expect(report.cacheHit).toBe(false);
    expect(report.effectiveQuality).toBe("low");
    const snapshot = prepared.snapshot();
    expect(snapshot.prepared).toBeDefined();
    expect(Array.from(snapshot.prepared!.irradiance)).toEqual(
      Array.from(preparedPayload("low").irradiance),
    );
    expect(prepared.estimatedGpuBytes()).toBeGreaterThan(0);
  });

  it("rejects inconsistent precompute results", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const mismatched = preparedSnapshotFor(ibl);
    mismatched.intensity = 99;
    await expectCodeAsync(
      () => ibl.prepare({ precomputeIbl: () => Promise.resolve(mismatched) }),
      "INVALID_INPUT",
    );
    const unprepared = preparedSnapshotFor(ibl);
    delete unprepared.prepared;
    await expectCodeAsync(
      () => ibl.prepare({ precomputeIbl: () => Promise.resolve(unprepared) }),
      "INVALID_INPUT",
    );
    const badPayload = preparedSnapshotFor(ibl);
    badPayload.prepared!.irradiance = new Uint8Array(8);
    await expectCodeAsync(
      () => ibl.prepare({ precomputeIbl: () => Promise.resolve(badPayload) }),
      "INVALID_INPUT",
    );
  });

  it("round-trips through iblFromSnapshot", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const prepared = await ibl.prepare({
      precomputeIbl: () => Promise.resolve(preparedSnapshotFor(ibl)),
    });
    const restored = iblFromSnapshot(prepared.snapshot());
    expect(restored.prepared).toBe(true);
    // Native-size payloads are megabytes; compare bytes directly rather than
    // through element-wise deep equality.
    const { prepared: restoredBytes, ...restoredMeta } = restored.snapshot();
    const { prepared: expectedBytes, ...expectedMeta } = prepared.snapshot();
    expect(restoredMeta).toEqual(expectedMeta);
    for (const plane of ["irradiance", "specular", "brdfLut"] as const) {
      expect(
        Buffer.from(restoredBytes![plane]).equals(Buffer.from(expectedBytes![plane])),
      ).toBe(true);
    }
  });

  it("rejects snapshots with a mismatched or tampered sourceHash", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const wrongHash = ibl.snapshot();
    wrongHash.source.sourceHash = "b".repeat(64);
    expect(() => iblFromSnapshot(wrongHash)).toThrowError(Forge3DError);
    const tamperedData = ibl.snapshot();
    tamperedData.source.data[0] = 0.9;
    expect(() => iblFromSnapshot(tamperedData)).toThrowError(Forge3DError);
  });

  it("rejects non-canonical rotation on snapshots", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    for (const rotationDegrees of [360, -0.5, 720, Number.NaN]) {
      const snapshot = ibl.snapshot();
      snapshot.rotationDegrees = rotationDegrees;
      expect(() => iblFromSnapshot(snapshot)).toThrowError(Forge3DError);
    }
  });

  it("rejects invalid report fields on snapshots", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const mutate = (fn: (report: IblSnapshot["report"]) => void) => {
      const snapshot = ibl.snapshot();
      fn(snapshot.report);
      return snapshot;
    };
    expect(() =>
      iblFromSnapshot(
        mutate((report) => {
          report.cacheBackend = "auto";
        }),
      ),
    ).toThrowError(Forge3DError);
    expect(() =>
      iblFromSnapshot(
        mutate((report) => {
          report.cacheBackend = "indexeddb" as never;
        }),
      ),
    ).toThrowError(Forge3DError);
    expect(() =>
      iblFromSnapshot(
        mutate((report) => {
          (report as { cacheHit: unknown }).cacheHit = "yes";
        }),
      ),
    ).toThrowError(Forge3DError);
    expect(() =>
      iblFromSnapshot(
        mutate((report) => {
          report.requestedQuality = "high";
        }),
      ),
    ).toThrowError(Forge3DError);
    expect(() =>
      iblFromSnapshot(
        mutate((report) => {
          report.brdfApproximation = "split-sum" as never;
        }),
      ),
    ).toThrowError(Forge3DError);
    expect(() =>
      iblFromSnapshot(
        mutate((report) => {
          (report as { reason: unknown }).reason = 7;
        }),
      ),
    ).toThrowError(Forge3DError);
    const noReport = ibl.snapshot();
    (noReport as { report?: unknown }).report = undefined;
    expect(() => iblFromSnapshot(noReport)).toThrowError(Forge3DError);
  });

  it("rejects effectiveMode inconsistent with the prepared payload", async () => {
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    const disabled = ibl.snapshot();
    disabled.report.effectiveMode = "disabled";
    expect(() => iblFromSnapshot(disabled)).toThrowError(Forge3DError);
    const claimed = ibl.snapshot();
    claimed.report.effectiveMode = "prepared-upload";
    expect(() => iblFromSnapshot(claimed)).toThrowError(Forge3DError);

    const prepared = await ibl.prepare({
      precomputeIbl: () => Promise.resolve(preparedSnapshotFor(ibl)),
    });
    const runtimeMode = prepared.snapshot();
    runtimeMode.report.effectiveMode = "runtime-precompute";
    expect(() => iblFromSnapshot(runtimeMode)).toThrowError(Forge3DError);
  });
});

interface FakeCacheStore {
  data: Map<string, Uint8Array>;
  failPut: boolean;
}

function installFakeCacheStorage(store: FakeCacheStore): void {
  const caches = {
    open: (_name: string) =>
      Promise.resolve({
        match: (request: unknown) => {
          const key = String(request);
          const bytes = store.data.get(key);
          return Promise.resolve(
            bytes === undefined
              ? undefined
              : {
                  arrayBuffer: () =>
                    Promise.resolve(
                      bytes.slice().buffer as ArrayBuffer,
                    ),
                },
          );
        },
        put: (request: unknown, response: unknown) => {
          if (store.failPut) {
            return Promise.reject(new Error("quota"));
          }
          const body = response as { arrayBuffer(): Promise<ArrayBuffer> };
          return body.arrayBuffer().then((buffer) => {
            store.data.set(String(request), new Uint8Array(buffer));
          });
        },
      }),
  };
  vi.stubGlobal("caches", caches);
}

function installFakeOpfs(files: Map<string, Uint8Array>): void {
  const directory = {
    getFileHandle: (name: string, options?: { create?: boolean }) => {
      const existing = files.get(name);
      if (existing === undefined && options?.create !== true) {
        return Promise.reject(new Error("not found"));
      }
      return Promise.resolve({
        getFile: () =>
          Promise.resolve({
            arrayBuffer: () =>
              Promise.resolve(existing!.slice().buffer as ArrayBuffer),
          }),
        createWritable: () =>
          Promise.resolve({
            write: (data: Uint8Array) => {
              files.set(name, data.slice());
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
      });
    },
    getDirectoryHandle: (_name: string, _options?: { create?: boolean }) =>
      Promise.resolve(directory),
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: () => Promise.resolve(directory) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IblCache", () => {
  it("reports backend none when storage is unavailable", async () => {
    const cache = new IblCache({ backend: "auto" });
    expect(cache.backend).toBe("none");
    expect(await cache.get("0".repeat(64))).toBeUndefined();
    await cache.put("0".repeat(64), preparedPayload("low"));
    const explicit = new IblCache({ backend: "cache-storage" });
    expect(explicit.backend).toBe("none");
    expect(await explicit.get("0".repeat(64))).toBeUndefined();
  });

  it("validates cache keys", async () => {
    const cache = new IblCache();
    await expectCodeAsync(() => cache.get("not-hex"), "INVALID_INPUT");
    await expectCodeAsync(
      () => cache.put("ABCDEF".repeat(11), preparedPayload("low")),
      "INVALID_INPUT",
    );
  });

  it("round-trips prepared payloads through cache storage byte-identically", async () => {
    const store: FakeCacheStore = { data: new Map(), failPut: false };
    installFakeCacheStorage(store);
    const cache = new IblCache({ backend: "cache-storage" });
    expect(cache.backend).toBe("cache-storage");
    const key = "a".repeat(64);
    expect(await cache.get(key)).toBeUndefined();
    const payload = preparedPayload("low");
    await cache.put(key, payload);
    const hit = await cache.get(key);
    expect(hit).toBeDefined();
    expect(hit!.irradianceSize).toBe(payload.irradianceSize);
    expect(Array.from(hit!.irradiance)).toEqual(Array.from(payload.irradiance));
    expect(Array.from(hit!.specular)).toEqual(Array.from(payload.specular));
    expect(Array.from(hit!.brdfLut)).toEqual(Array.from(payload.brdfLut));
    expect(store.data.keys().next().value).toContain("/.forge3d/ibl/");
  });

  it("treats corrupted entries as misses", async () => {
    const store: FakeCacheStore = { data: new Map(), failPut: false };
    installFakeCacheStorage(store);
    const cache = new IblCache({ backend: "cache-storage" });
    const key = "b".repeat(64);
    const payload = preparedPayload("low");
    await cache.put(key, payload);
    const storedKey = [...store.data.keys()][0]!;
    const corrupted = store.data.get(storedKey)!.slice();
    corrupted[10] ^= 0xff;
    store.data.set(storedKey, corrupted);
    expect(await cache.get(key)).toBeUndefined();
    store.data.set(storedKey, new Uint8Array(4));
    expect(await cache.get(key)).toBeUndefined();
  });

  it("downgrades quota failures to no-ops", async () => {
    const store: FakeCacheStore = { data: new Map(), failPut: true };
    installFakeCacheStorage(store);
    const cache = new IblCache({ backend: "cache-storage" });
    await cache.put("c".repeat(64), preparedPayload("low"));
    expect(await cache.get("c".repeat(64))).toBeUndefined();
  });

  it("round-trips through OPFS", async () => {
    const files = new Map<string, Uint8Array>();
    installFakeOpfs(files);
    const cache = new IblCache({ backend: "opfs" });
    expect(cache.backend).toBe("opfs");
    const key = "d".repeat(64);
    expect(await cache.get(key)).toBeUndefined();
    await cache.put(key, preparedPayload("medium"));
    const hit = await cache.get(key);
    expect(hit).toBeDefined();
    expect(hit!.specularMipCount).toBe(6);
    expect(files.keys().next().value).toBe(`${key}.ibl`);
  });

  it("selects cache storage automatically when available", () => {
    const store: FakeCacheStore = { data: new Map(), failPut: false };
    installFakeCacheStorage(store);
    const cache = new IblCache({ backend: "auto" });
    expect(cache.backend).toBe("cache-storage");
  });
});

describe("ImageBasedLighting.prepare caching", () => {
  it("reports a miss then a hit with byte-identical payloads", async () => {
    const store: FakeCacheStore = { data: new Map(), failPut: false };
    installFakeCacheStorage(store);
    const cache = new IblCache({ backend: "cache-storage" });
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    let computes = 0;
    const target: IblPrecomputeTarget = {
      precomputeIbl: (input) => {
        computes += 1;
        return Promise.resolve(preparedSnapshotFor(iblFromSnapshot(input)));
      },
    };
    const first = await ibl.prepare(target, cache);
    expect(computes).toBe(1);
    expect(first.report.cacheHit).toBe(false);
    expect(first.report.cacheBackend).toBe("cache-storage");
    const second = await ibl.prepare(target, cache);
    expect(computes).toBe(1);
    expect(second.report.cacheHit).toBe(true);
    expect(second.report.cacheBackend).toBe("cache-storage");
    expect(second.report.effectiveMode).toBe("prepared-upload");
    expect(Array.from(second.snapshot().prepared!.specular)).toEqual(
      Array.from(first.snapshot().prepared!.specular),
    );
  });

  it("treats a higher-quality cached entry as a miss", async () => {
    const store: FakeCacheStore = { data: new Map(), failPut: false };
    installFakeCacheStorage(store);
    const cache = new IblCache({ backend: "cache-storage" });
    const ibl = await ImageBasedLighting.fromLinear(linearImage(), {
      quality: "low",
    });
    await cache.put(await ibl.cacheKey(), preparedPayload("medium"));
    let computes = 0;
    const prepared = await ibl.prepare(
      {
        precomputeIbl: (input) => {
          computes += 1;
          return Promise.resolve(preparedSnapshotFor(iblFromSnapshot(input)));
        },
      },
      cache,
    );
    expect(computes).toBe(1);
    expect(prepared.report.cacheHit).toBe(false);
    expect(prepared.report.effectiveQuality).toBe("low");
  });
});
