import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import {
  estimateTerrainMaterialBytes,
  getTerrainMaterialDefaults,
  normalizeTerrainMaterial,
  TERRAIN_MATERIAL_UNIFORM_BYTES,
} from "../../src-ts/terrain-material.js";
import type { TerrainMaterialInput } from "../../src-ts/index.js";

function errorOf(input: unknown): Forge3DError {
  try {
    normalizeTerrainMaterial(input as TerrainMaterialInput);
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    return error as Forge3DError;
  }
  throw new Error("expected INVALID_INPUT");
}

describe("terrain material defaults", () => {
  it("resolve to the native settings with every feature off", () => {
    const defaults = getTerrainMaterialDefaults();
    expect(defaults.albedoMode).toBe("colormap");
    expect(defaults.colormapStrength).toBe(1);
    expect(defaults.gamma).toBe(2.2);
    expect(defaults.hueVariation).toBe(0.08);
    // Native MaterialSet.terrain_default(): rock, grass, dirt, snow.
    expect(defaults.materialSet.map((layer) => [layer.baseColor, layer.roughness])).toEqual([
      [[0.28, 0.26, 0.24], 0.5],
      [[0.18, 0.38, 0.1], 0.85],
      [[0.35, 0.25, 0.15], 0.5],
      [[0.95, 0.97, 1.0], 0.25],
    ]);
    // Native make_terrain_params_config defaults (POM kept off for the
    // zero-feature baseline).
    expect(defaults.triplanar).toEqual({ scale: 6, blendSharpness: 4, normalStrength: 1 });
    expect(defaults.pom).toEqual({
      enabled: false,
      mode: "occlusion",
      scale: 0.04,
      minSteps: 12,
      maxSteps: 40,
      refineSteps: 4,
      shadow: true,
      occlusion: true,
    });
    expect(defaults.lod).toEqual({ level: 0, bias: 0, lod0Bias: -0.5 });
    expect(defaults.sampling.anisotropy).toBe(8);
    expect(defaults.clamp).toEqual({
      heightRange: null,
      slopeRange: [0.04, 1],
      ambientRange: [0.22, 0.38],
      shadowRange: [0.3, 1],
      occlusionRange: [0.65, 1],
    });
    expect(defaults.layers.snow.enabled).toBe(false);
    expect(defaults.layers.snow.altitudeMin).toBe(2000);
    expect(defaults.layers.rock.color).toEqual([0.35, 0.32, 0.28]);
    expect(defaults.layers.variation.octaves).toBe(4);
    expect(defaults.detail.enabled).toBe(false);
    expect(defaults.detail.fadeEnd).toBe(200);
    expect(defaults.specularAa).toEqual({ quality: "native", sigmaScale: 1 });
    expect(defaults.debugView).toBe("none");
  });

  it("returns an independent snapshot on every call", () => {
    const first = getTerrainMaterialDefaults();
    first.materialSet[0]!.baseColor[0] = 1;
    first.pom.enabled = true;
    const second = getTerrainMaterialDefaults();
    expect(second.materialSet[0]!.baseColor[0]).toBe(0.28);
    expect(second.pom.enabled).toBe(false);
  });
});

describe("normalizeTerrainMaterial", () => {
  it("merges partial sections over the defaults", () => {
    const material = normalizeTerrainMaterial({
      albedoMode: "mix",
      colormapStrength: 0.25,
      pom: { enabled: true, scale: 0.05 },
      layers: { snow: { enabled: true, altitudeMin: 0.78 } },
    });
    expect(material.albedoMode).toBe("mix");
    expect(material.pom).toMatchObject({ enabled: true, scale: 0.05, minSteps: 12, maxSteps: 40 });
    expect(material.layers.snow).toMatchObject({ enabled: true, altitudeMin: 0.78, altitudeBlend: 500 });
    expect(material.layers.rock.enabled).toBe(false);
  });

  it("copies caller images, masks and LUTs defensively", () => {
    const data = new Uint8Array([10, 20, 30, 255]);
    const lut = new Float32Array(256).fill(0.5);
    const material = normalizeTerrainMaterial({
      materialSet: [{ baseColor: [0.3, 0.3, 0.3], roughness: 0.5, texture: { width: 1, height: 1, data } }],
      heightCurve: { mode: "lut", strength: 1, lut },
      layers: { rock: { mask: { width: 1, height: 1, data: new Uint8Array([200]) } } },
    });
    data[0] = 99;
    lut[0] = 0.9;
    expect(material.materialSet[0]!.texture!.data[0]).toBe(10);
    expect(material.heightCurve.lut![0]).toBe(0.5);
    expect(material.layers.rock.mask!.data[0]).toBe(200);
    expect(material.heightCurve.lut).toBeInstanceOf(Float32Array);
  });

  it("rejects invalid fields with the native validation wording", () => {
    const cases: [unknown, string, string][] = [
      [{ pom: { maxSteps: 101 } }, "material.pom.maxSteps", "max_steps must be <= 100"],
      [{ pom: { minSteps: 20, maxSteps: 10 } }, "material.pom.maxSteps", "max_steps must be >= min_steps"],
      [{ triplanar: { scale: 0 } }, "material.triplanar.scale", "scale must be > 0"],
      [{ layers: { snow: { slopeMax: 95 } } }, "material.layers.snow.slopeMax", "snow_slope_max must be in [0, 90]"],
      [{ heightCurve: { mode: "lut" } }, "material.heightCurve.lut", "height_curve_lut is required when height_curve_mode='lut'"],
      [{ heightCurve: { lut: new Float32Array(10) } }, "material.heightCurve.lut", "height_curve_lut must be a 1D float32 array of length 256"],
      [{ layers: { variation: { octaves: 9 } } }, "material.layers.variation.octaves", "octaves must be in [1, 8]"],
      [{ materialSet: [] }, "material.materialSet", "must contain between 1 and 4 layers"],
      [{ materialSet: [{ baseColor: [0, 0, 0], roughness: 0.01 }] }, "material.materialSet[0].roughness", "roughness must be in [0.04, 1.0]"],
      [{ albedoMode: "overlay" }, "material.albedoMode", "must be one of material, colormap, mix"],
      [{ layers: { rock: { subsurfaceTint: [0.5, 2, 0.5] } } }, "material.layers.rock.subsurfaceTint", "rock_subsurface_tint components must be in [0, 1]"],
      [{ detail: { fadeStart: 100, fadeEnd: 50 } }, "material.detail.fadeEnd", "fade_end must be > fade_start"],
      [{ clamp: { heightRange: [1, 0] } }, "material.clamp.heightRange", "height_range: min must be < max"],
      [{ colormapStrength: Number.NaN }, "material.colormapStrength", "must be finite"],
      [{ specularAa: { quality: "ultra" } }, "material.specularAa.quality", "must be one of off, native, medium, high"],
      [{ materialSet: [{ texture: { width: 2, height: 2, data: [1, 2] } }] }, "material.materialSet[0].texture", "data must be a Uint8Array"],
    ];
    for (const [input, field, message] of cases) {
      const error = errorOf(input);
      expect(error.code, field).toBe("INVALID_INPUT");
      expect(error.details?.field, message).toBe(field);
      expect(error.message).toContain(message);
    }
  });

  it("estimates GPU bytes from the first texture and the auxiliary maps", () => {
    expect(estimateTerrainMaterialBytes(undefined)).toBe(0);
    // Four flat layers: one texel each, a 1x1 two-layer aux array, the uniform.
    expect(estimateTerrainMaterialBytes({})).toBe(4 * 4 + 1 * 1 * 4 * 2 + TERRAIN_MATERIAL_UNIFORM_BYTES);
    const textured = estimateTerrainMaterialBytes({
      materialSet: [
        { texture: { width: 4, height: 4, data: new Uint8Array(64) } },
        { baseColor: [0.2, 0.2, 0.2], roughness: 0.5 },
      ],
      detail: { strength: 0.5, normalMap: { width: 8, height: 2, data: new Uint8Array(64) } },
    });
    const mipChain = (4 * 4 + 2 * 2 + 1) * 2 * 4;
    expect(textured).toBe(mipChain + 8 * 2 * 4 * 2 + TERRAIN_MATERIAL_UNIFORM_BYTES);
  });
});

describe("scene integration", () => {
  it("validates the material when the terrain is added", () => {
    const scene = Forge3DScene.create();
    expect(() =>
      scene.addTerrain({
        width: 2,
        height: 2,
        heights: new Float32Array(4),
        material: { pom: { maxSteps: 500 } },
      }),
    ).toThrowError(/max_steps must be <= 100/);
    expect(() =>
      scene.addTerrain({
        width: 2,
        height: 2,
        heights: new Float32Array(4),
        material: { albedoMode: "mix" },
      }),
    ).not.toThrow();
  });
});
