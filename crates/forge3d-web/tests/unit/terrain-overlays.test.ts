// W08 (F5): pure-TypeScript overlay normalization — defaults, exact
// native-mirroring output JSON, placement mutual exclusion, visibility
// epsilon + z-order stability, and decodeOverlayImage.

import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import {
  decodeOverlayImage,
  getTerrainOverlayDefaults,
  isTerrainOverlayLayerVisible,
  normalizeTerrainOverlays,
  terrainOverlayVisibleLayers,
} from "../../src-ts/terrain-overlay.js";

const rgba = (pixels: number): Uint8Array =>
  new Uint8Array(pixels * 4).fill(255);

function layer(overrides: Record<string, unknown> = {}) {
  return {
    image: { width: 1, height: 1, data: rgba(1) },
    ...overrides,
  };
}

describe("getTerrainOverlayDefaults", () => {
  it("matches the native OverlaySettings::default exactly", () => {
    expect(getTerrainOverlayDefaults()).toEqual({
      enabled: false,
      globalOpacity: 1.0,
      resolutionScale: 1.0,
      layers: [],
    });
  });
});

describe("normalizeTerrainOverlays", () => {
  it("applies native defaults to a minimal block", () => {
    const normalized = normalizeTerrainOverlays({
      layers: [layer({ extent: [0, 0, 1, 1] })],
    });
    // Identical output to the core Rust resolution for the same input.
    expect(normalized).toEqual({
      enabled: true,
      globalOpacity: 1.0,
      resolutionScale: 1.0,
      layers: [
        {
          name: "layer0",
          image: { width: 1, height: 1, data: rgba(1) },
          extent: [0, 0, 1, 1],
          opacity: 1.0,
          blendMode: "normal",
          visible: true,
          zOrder: 0,
        },
      ],
    });
  });

  it("normalizes a fully specified stack verbatim", () => {
    const normalized = normalizeTerrainOverlays({
      enabled: true,
      globalOpacity: 0.5,
      resolutionScale: 1.5,
      layers: [
        layer({
          name: "topo",
          extent: [0.1, 0.2, 0.9, 0.8],
          opacity: 0.75,
          blendMode: "multiply",
          visible: true,
          zOrder: 2,
        }),
        layer({
          name: "mask",
          crs: "EPSG:4326",
          crsBounds: [-1, -1, 1, 1],
          opacity: 0.4,
          blendMode: "overlay",
          visible: false,
          zOrder: -1,
        }),
      ],
    });
    expect(normalized.enabled).toBe(true);
    expect(normalized.globalOpacity).toBe(0.5);
    expect(normalized.resolutionScale).toBe(1.5);
    expect(normalized.layers[0]).toEqual({
      name: "topo",
      image: { width: 1, height: 1, data: rgba(1) },
      extent: [0.1, 0.2, 0.9, 0.8],
      opacity: 0.75,
      blendMode: "multiply",
      visible: true,
      zOrder: 2,
    });
    expect(normalized.layers[1]).toMatchObject({
      name: "mask",
      crs: "EPSG:4326",
      crsBounds: [-1, -1, 1, 1],
      opacity: 0.4,
      blendMode: "overlay",
      visible: false,
      zOrder: -1,
    });
    expect(normalized.layers[1]).not.toHaveProperty("extent");
  });

  it("rejects non-object input", () => {
    expect(() => normalizeTerrainOverlays(null as never)).toThrow(
      Forge3DError,
    );
    expect(() => normalizeTerrainOverlays([] as never)).toThrow(
      Forge3DError,
    );
  });

  it("rejects extent + crs/crsBounds together (mutually exclusive)", () => {
    expect(() =>
      normalizeTerrainOverlays({
        layers: [
          layer({
            extent: [0, 0, 1, 1],
            crs: "EPSG:4326",
            crsBounds: [0, 0, 1, 1],
          }),
        ],
      }),
    ).toThrowError(/mutually exclusive/);
    // crsBounds without extent also triggers the check.
    expect(() =>
      normalizeTerrainOverlays({
        layers: [
          layer({
            extent: [0, 0, 1, 1],
            crsBounds: [0, 0, 1, 1],
          }),
        ],
      }),
    ).toThrowError(/mutually exclusive/);
  });

  it("rejects crs without crsBounds", () => {
    expect(() =>
      normalizeTerrainOverlays({
        layers: [layer({ crs: "EPSG:4326" })],
      }),
    ).toThrowError(/crs requires crsBounds/);
  });

  it("enforces opacity, blend mode, and extent validation verbatim", () => {
    expect(() =>
      normalizeTerrainOverlays({
        globalOpacity: 1.5,
        layers: [],
      }),
    ).toThrowError(/global_opacity must be in \[0.0, 1.0\]/);
    expect(() =>
      normalizeTerrainOverlays({
        resolutionScale: 0.05,
        layers: [],
      }),
    ).toThrowError(/resolution_scale must be in \[0.1, 2.0\]/);
    expect(() =>
      normalizeTerrainOverlays({
        layers: [layer({ opacity: -0.1 })],
      }),
    ).toThrowError(/opacity must be in \[0.0, 1.0\]/);
    expect(() =>
      normalizeTerrainOverlays({
        layers: [layer({ blendMode: "screen" })],
      }),
    ).toThrowError(
      /blend_mode must be one of \['multiply', 'normal', 'overlay'\], got 'screen'/,
    );
    expect(() =>
      normalizeTerrainOverlays({
        layers: [layer({ extent: [1, 0, 0, 1] })],
      }),
    ).toThrowError(/u_min < u_max and v_min < v_max/);
    expect(() =>
      normalizeTerrainOverlays({
        layers: [layer({ crs: "EPSG:4326", crsBounds: [2, 0, 1, 1] })],
      }),
    ).toThrowError(/u_min < u_max and v_min < v_max/);
  });

  it("rejects malformed images with the native error", () => {
    expect(() =>
      normalizeTerrainOverlays({
        layers: [layer({ image: { width: 0, height: 1, data: rgba(0) } })],
      }),
    ).toThrowError(/width and height must be positive integers/);
    expect(() =>
      normalizeTerrainOverlays({
        layers: [
          layer({ image: { width: 1, height: 1, data: new Uint8Array(3) } }),
        ],
      }),
    ).toThrowError(/overlay image must be 1x1 RGBA8 \(4 bytes\), got 3/);
  });

  it("caps effectively-visible layers at eight", () => {
    const layers = Array.from({ length: 9 }, (_, i) =>
      layer({ name: `l${i}`, zOrder: i }),
    );
    expect(() =>
      normalizeTerrainOverlays({ layers }),
    ).toThrowError(/at most 8 visible layers, got 9/);
    // Hidden / epsilon-opacity layers do not count.
    const hidden = layers.slice(0, 8).concat([
      layer({ visible: false }),
      layer({ opacity: 0.0005 }),
    ]);
    expect(normalizeTerrainOverlays({ layers: hidden }).layers.length).toBe(
      10,
    );
  });
});

describe("overlay visibility and ordering", () => {
  it("is_effectively_visible mirrors `visible && opacity > 0.001`", () => {
    const settings = normalizeTerrainOverlays({
      layers: [
        layer({ opacity: 1 }),
        layer({ opacity: 0.0009 }),
        layer({ visible: false }),
        layer({ opacity: 0.0011 }),
      ],
    });
    expect(settings.layers.map(isTerrainOverlayLayerVisible)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("visible_layers sorts by zOrder stably", () => {
    const settings = normalizeTerrainOverlays({
      layers: [
        layer({ name: "a", zOrder: 2 }),
        layer({ name: "b", zOrder: -1 }),
        layer({ name: "c", zOrder: 2 }),
        layer({ name: "d", zOrder: 0, visible: false }),
      ],
    });
    const names = terrainOverlayVisibleLayers(settings).map((l) => l.name);
    expect(names).toEqual(["b", "a", "c"]);
  });
});

describe("decodeOverlayImage", () => {
  it("passes Uint8Array image objects through", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const image = await decodeOverlayImage({ width: 1, height: 1, data });
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
    expect(Array.from(image.data)).toEqual([1, 2, 3, 4]);
  });

  it("accepts rgba aliases and Uint8ClampedArray data", async () => {
    const clamped = new Uint8ClampedArray([9, 8, 7, 6]);
    const image = await decodeOverlayImage({
      width: 1,
      height: 1,
      data: clamped,
    });
    expect(image.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(image.data)).toEqual([9, 8, 7, 6]);
    const viaRgba = await decodeOverlayImage({
      width: 1,
      height: 1,
      rgba: new Uint8Array([5, 6, 7, 8]),
    });
    expect(Array.from(viaRgba.data)).toEqual([5, 6, 7, 8]);
  });

  it("rejects malformed image objects", async () => {
    await expect(
      decodeOverlayImage({ width: 2, height: 2, data: new Uint8Array(4) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      decodeOverlayImage({} as never),
    ).rejects.toThrow();
  });
});
