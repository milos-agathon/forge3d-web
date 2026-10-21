// W08 (F5): pure-TypeScript virtual-texture normalization mirroring
// `VtJs::to_settings` + core `TerrainVtSettings::validate` — defaults,
// test_tv20 / test_p2_vt_family_validation equivalents, and exact
// native error wording.

import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import { normalizeTerrainVirtualTexture } from "../../src-ts/terrain-overlay.js";

describe("normalizeTerrainVirtualTexture", () => {
  it("returns the disabled core default for undefined input", () => {
    expect(normalizeTerrainVirtualTexture()).toEqual({
      enabled: false,
      atlasSize: 4096,
      residencyBudgetMb: 256.0,
      maxMipLevels: 8,
      useFeedback: true,
      layers: [],
    });
  });

  it("applies native defaults when the block is present", () => {
    const normalized = normalizeTerrainVirtualTexture({});
    // `enabled` defaults to true on a present block (native
    // `VtJs::to_settings`).
    expect(normalized.enabled).toBe(true);
    expect(normalized.atlasSize).toBe(4096);
    expect(normalized.residencyBudgetMb).toBe(256.0);
    expect(normalized.maxMipLevels).toBe(8);
    expect(normalized.useFeedback).toBe(true);
    expect(normalized.layers).toEqual([]);
  });

  it("applies native layer defaults (albedo, 4096², 248+4, gray fallback)", () => {
    const normalized = normalizeTerrainVirtualTexture({
      layers: [{}],
    });
    expect(normalized.layers).toEqual([
      {
        family: "albedo",
        virtualSizePx: [4096, 4096],
        tileSize: 248,
        tileBorder: 4,
        fallback: [0.5, 0.5, 0.5, 1.0],
      },
    ]);
  });

  it("normalizes a fully specified layer verbatim", () => {
    const normalized = normalizeTerrainVirtualTexture({
      enabled: true,
      atlasSize: 512,
      residencyBudgetMb: 0.75,
      maxMipLevels: 4,
      useFeedback: false,
      layers: [
        {
          family: "albedo",
          virtualSizePx: [2048, 1024],
          tileSize: 120,
          tileBorder: 4,
          fallback: [1, 0, 0, 1],
        },
      ],
    });
    expect(normalized).toEqual({
      enabled: true,
      atlasSize: 512,
      residencyBudgetMb: 0.75,
      maxMipLevels: 4,
      useFeedback: false,
      layers: [
        {
          family: "albedo",
          virtualSizePx: [2048, 1024],
          tileSize: 120,
          tileBorder: 4,
          fallback: [1, 0, 0, 1],
        },
      ],
    });
  });

  it("accepts all three valid families (native valid set)", () => {
    for (const family of ["albedo", "normal", "mask"] as const) {
      const normalized = normalizeTerrainVirtualTexture({
        layers: [{ family }],
      });
      expect(normalized.layers[0]!.family).toBe(family);
    }
  });

  it("rejects an unknown family with the native message", () => {
    expect(() =>
      normalizeTerrainVirtualTexture({
        layers: [{ family: "roughness" as never }],
      }),
    ).toThrowError(/family must be one of \['albedo', 'mask', 'normal'\]/);
  });

  it("rejects duplicate families", () => {
    expect(() =>
      normalizeTerrainVirtualTexture({
        layers: [{ family: "albedo" }, { family: "albedo" }],
      }),
    ).toThrowError(/duplicate family in layers/);
    // Different families are fine.
    expect(
      normalizeTerrainVirtualTexture({
        layers: [{ family: "albedo" }, { family: "mask" }],
      }).layers.length,
    ).toBe(2);
  });

  it("validates atlas size, divisibility, budget, and mip levels", () => {
    expect(() =>
      normalizeTerrainVirtualTexture({ atlasSize: 255 }),
    ).toThrowError(/atlas_size must be >= 256/);
    // slot_size = tileSize + 2 * tileBorder; native checks atlas %
    // slot per layer.
    expect(() =>
      normalizeTerrainVirtualTexture({
        atlasSize: 300,
        layers: [
          { family: "albedo", tileSize: 120, tileBorder: 4 },
        ],
      }),
    ).toThrowError(
      /atlas_size \(300\) must be divisible by slot_size \(128\) for family 'albedo'/,
    );
    expect(() =>
      normalizeTerrainVirtualTexture({ residencyBudgetMb: 0 }),
    ).toThrowError(/residency_budget_mb must be > 0/);
    expect(() =>
      normalizeTerrainVirtualTexture({ maxMipLevels: 0 }),
    ).toThrowError(/max_mip_levels must be >= 1/);
  });

  it("validates tile size and virtual size bounds", () => {
    expect(() =>
      normalizeTerrainVirtualTexture({
        layers: [{ family: "albedo", tileSize: 8 }],
      }),
    ).toThrowError(/tile_size must be >= 16/);
    expect(() =>
      normalizeTerrainVirtualTexture({
        layers: [
          {
            family: "albedo",
            tileSize: 256,
            virtualSizePx: [128, 4096],
          },
        ],
      }),
    ).toThrowError(/virtual_size_px must be >= tile_size in both dimensions/);
  });

  it("reports Forge3DError with the invalid-input reason", () => {
    try {
      normalizeTerrainVirtualTexture({ atlasSize: 64 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Forge3DError);
      expect((error as Forge3DError).code).toBe("INVALID_INPUT");
      expect((error as Forge3DError).details).toMatchObject({
        reason: "invalid-input",
        field: "vt.atlas_size",
      });
    }
  });
});
