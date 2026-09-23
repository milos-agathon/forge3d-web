import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import {
  getRendererPreset,
  RendererConfig,
  rendererPresetNames,
} from "../../src-ts/renderer-config.js";
import type {
  RendererConfigData,
  RendererConfigInput,
} from "../../src-ts/index.js";

const DEFAULTS: RendererConfigData = {
  quality: "high",
  memoryBudgetBytes: 512 * 1024 * 1024,
  overflowPolicy: "downscale",
  timestampMode: "auto",
  sampleCount: 1,
  lighting: { exposure: 1, lights: [] },
  materials: {},
  shading: {
    brdf: "cooktorrance-ggx",
    roughness: 0.5,
    metallic: 0,
    normalMaps: true,
  },
  shadows: { enabled: false, technique: "pcf", mapSize: 2048, cascades: 1 },
  gi: { modes: [], ambientOcclusionStrength: 0 },
  atmosphere: { enabled: false, sky: "hosek-wilkie" },
};

const PRESET_SNAPSHOTS: Record<string, RendererConfigData> = {
  "studio-pbr": {
    ...DEFAULTS,
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [-0.3, -0.95, -0.2],
          intensity: 6,
          color: [1, 0.98, 0.95],
        },
      ],
    },
    shading: {
      brdf: "disney-principled",
      roughness: 0.35,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcf", mapSize: 2048, cascades: 1 },
    gi: { modes: [], ambientOcclusionStrength: 0 },
    atmosphere: { enabled: false, sky: "hosek-wilkie" },
  },
  "outdoor-sun": {
    ...DEFAULTS,
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [-0.35, -1, -0.25],
          intensity: 5,
          color: [1, 0.97, 0.92],
        },
      ],
    },
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.5,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcf", mapSize: 2048, cascades: 3 },
    gi: { modes: [], ambientOcclusionStrength: 0 },
    atmosphere: { enabled: true, sky: "hosek-wilkie" },
  },
  "toon-viz": {
    ...DEFAULTS,
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [-0.4, -0.9, -0.1],
          intensity: 4,
          color: [1, 1, 1],
        },
      ],
    },
    shading: {
      brdf: "toon",
      roughness: 0.5,
      metallic: 0,
      normalMaps: false,
    },
    shadows: { enabled: true, technique: "hard", mapSize: 1024, cascades: 1 },
    gi: { modes: [], ambientOcclusionStrength: 0 },
    atmosphere: { enabled: false, sky: "hosek-wilkie" },
  },
  "rainier-showcase": {
    ...DEFAULTS,
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [0.64, 0.42, -0.64],
          intensity: 4,
          color: [1, 0.95, 0.9],
        },
      ],
    },
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.6,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcss", mapSize: 4096, cascades: 4 },
    gi: { modes: ["ibl"], ambientOcclusionStrength: 0 },
    atmosphere: { enabled: true, sky: "hdri" },
  },
  "rainier-relief": {
    ...DEFAULTS,
    lighting: {
      exposure: 1.2,
      lights: [
        {
          type: "directional",
          direction: [
            -0.6724985119639573, 0.3090169943749474, -0.6724985119639575,
          ],
          intensity: 5,
          color: [1, 0.92, 0.85],
        },
      ],
    },
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.55,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcss", mapSize: 4096, cascades: 4 },
    gi: { modes: ["ibl"], ambientOcclusionStrength: 0 },
    atmosphere: { enabled: true, sky: "hdri" },
  },
};

function expectInvalid(factory: () => unknown): void {
  expect(factory).toThrowError(Forge3DError);
  try {
    factory();
  } catch (error) {
    expect((error as Forge3DError).code).toBe("INVALID_INPUT");
    return;
  }
  throw new Error("expected INVALID_INPUT");
}

describe("RendererConfig", () => {
  it("round-trips defaults through toJSON", () => {
    const config = new RendererConfig();
    expect(config.toJSON()).toEqual(DEFAULTS);
    expect(RendererConfig.from().toJSON()).toEqual(DEFAULTS);
  });

  it("isolates input sources and toJSON output", () => {
    const lights = [
      {
        type: "directional",
        intensity: 3,
        color: [1, 1, 1] as [number, number, number],
        direction: [0, -1, 0] as [number, number, number],
      },
    ];
    const input: RendererConfigInput = {
      lighting: { exposure: 1.5, lights },
      shading: { roughness: 0.9 },
    };
    const config = new RendererConfig(input);
    lights[0]!.intensity = 99;
    input.lighting!.exposure = 99;

    const data = config.toJSON();
    expect(data.lighting.exposure).toBe(1.5);
    expect(data.lighting.lights[0]!.intensity).toBe(3);
    expect(data.shading.roughness).toBe(0.9);
    expect(data.shading.brdf).toBe("cooktorrance-ggx");

    data.lighting.lights[0]!.intensity = 42;
    data.materials["injected"] = { id: "x", model: "y", parameters: {} };
    const again = config.toJSON();
    expect(again.lighting.lights[0]!.intensity).toBe(3);
    expect(again.materials["injected"]).toBeUndefined();
  });

  it("deep merges sections on copy and removes brdfOverride with null", () => {
    const base = new RendererConfig({
      shading: { roughness: 0.2, metallic: 0.8 },
      shadows: { enabled: true, mapSize: 1024, cascades: 2 },
      brdfOverride: "toon",
    });
    const copied = base.copy({
      shading: { metallic: 0.1 },
      lighting: { lights: [] },
      brdfOverride: null,
    });
    const data = copied.toJSON();
    expect(data.shading).toEqual({
      brdf: "cooktorrance-ggx",
      roughness: 0.2,
      metallic: 0.1,
      normalMaps: true,
    });
    expect(data.shadows.mapSize).toBe(1024);
    expect(data.lighting.lights).toEqual([]);
    expect("brdfOverride" in data).toBe(false);

    const unchanged = base.toJSON();
    expect(unchanged.brdfOverride).toBe("toon");
    expect(unchanged.shading.metallic).toBe(0.8);
  });

  it("resolves shading and override brdfs through the shared route table", () => {
    const base = new RendererConfig();
    expect(base.getBrdfRoute().model).toBe("cooktorrance-ggx");
    expect(base.getBrdfRoute().implementation).toBe("exact");

    const alias = new RendererConfig({ shading: { brdf: "ggx" } });
    const aliasRoute = alias.getBrdfRoute();
    expect(aliasRoute.model).toBe("cooktorrance-ggx");
    expect(aliasRoute.implementation).toBe("alias");
    expect(aliasRoute.diagnostic).toBe("ggx is an alias for cooktorrance-ggx");

    const overridden = new RendererConfig({
      shading: { brdf: "lambert" },
      brdfOverride: "sss",
    });
    const route = overridden.getBrdfRoute();
    expect(route.model).toBe("subsurface");
    expect(route.effectiveModel).toBe("disney-principled");
    expect(route.implementation).toBe("approximation");
    expect(route.diagnostic).toContain("approximated by disney-principled");
    expect(route.diagnostic).toContain("input alias sss resolves to subsurface");

    const preset = RendererConfig.preset("toon-viz");
    expect(preset.getBrdfRoute().model).toBe("toon");
  });

  it("returns a defensive copy from RendererConfig.from on a config", () => {
    const original = new RendererConfig({ quality: "low" });
    const derived = RendererConfig.from(original);
    expect(derived).not.toBe(original);
    expect(derived.toJSON()).toEqual(original.toJSON());
  });

  it("rejects invalid numeric, vector, and shadow values", () => {
    expectInvalid(
      () => new RendererConfig({ memoryBudgetBytes: 0 }),
    );
    expectInvalid(
      () => new RendererConfig({ memoryBudgetBytes: Number.MAX_VALUE }),
    );
    expectInvalid(() => new RendererConfig({ sampleCount: 2 as 1 }));
    expectInvalid(
      () => new RendererConfig({ lighting: { exposure: -1 } }),
    );
    expectInvalid(
      () =>
        new RendererConfig({
          lighting: {
            lights: [
              {
                type: "directional",
                intensity: 1,
                color: [1.5, 0, 0],
              },
            ],
          },
        }),
    );
    expectInvalid(
      () =>
        new RendererConfig({
          lighting: {
            lights: [
              {
                type: "directional",
                intensity: 1,
                color: [1, 1, 1],
                direction: [0, 0, 0],
              },
            ],
          },
        }),
    );
    expectInvalid(
      () => new RendererConfig({ shading: { roughness: 1.5 } }),
    );
    expectInvalid(
      () => new RendererConfig({ gi: { ambientOcclusionStrength: -0.1 } }),
    );
    expectInvalid(
      () =>
        new RendererConfig({
          shadows: { enabled: true, mapSize: 1000, cascades: 2 },
        }),
    );
    expectInvalid(
      () =>
        new RendererConfig({
          shadows: { enabled: true, mapSize: 2048, cascades: 5 },
        }),
    );
    expectInvalid(
      () => new RendererConfig({ shading: { brdf: "" } }),
    );
    expectInvalid(
      () => new RendererConfig({ shading: { brdf: "custom-brdf" } }),
    );
    expectInvalid(
      () => new RendererConfig({ shading: { brdf: "pbr" } }),
    );
    expectInvalid(
      () => new RendererConfig({ brdfOverride: "not-a-model" }),
    );
    expectInvalid(() => new RendererConfig({ brdfOverride: "" }));
    expectInvalid(
      () =>
        new RendererConfig({
          materials: {
            slot: { id: "", model: "pbr", parameters: {} },
          },
        }),
    );
    const withParameter = (value: unknown) => () =>
      new RendererConfig({
        materials: {
          slot: { id: "slot", parameters: { baseColor: value as never } },
        },
      });
    expectInvalid(withParameter([0.5, 0.5, 0.5]));
    expectInvalid(withParameter([0.5, 0.5, 0.5, 1, 0]));
    expectInvalid(withParameter([0.5, 0.5, 0.5, 1.5]));
    expectInvalid(withParameter([0.5, 0.5, 0.5, -0.1]));
    expectInvalid(withParameter([0.5, 0.5, 0.5, Number.NaN]));
    expectInvalid(withParameter([0.5, 0.5, 0.5, Number.POSITIVE_INFINITY]));
    expectInvalid(withParameter([0.5, "x", 0.5, 1]));
    expectInvalid(withParameter({ r: 1, g: 1, b: 1, a: 1 }));
    expectInvalid(withParameter(Number.NaN));
    expectInvalid(
      () =>
        new RendererConfig({ quality: "medium-high" as never }),
    );
  });

  it("accepts baseColor tuples and scalar material parameters", () => {
    const config = new RendererConfig({
      materials: {
        hero: {
          id: "hero",
          model: "pbr",
          parameters: {
            baseColor: [0.8, 0.6, 0.4, 1],
            metallic: 1,
            enabled: true,
            label: "hero",
          },
        },
      },
    });
    const data = config.toJSON();
    expect(data.materials.hero.parameters.baseColor).toEqual([
      0.8, 0.6, 0.4, 1,
    ]);
    expect(data.materials.hero.parameters.metallic).toBe(1);
    expect(data.materials.hero.parameters.enabled).toBe(true);
    expect(data.materials.hero.parameters.label).toBe("hero");
  });

  it("rejects unknown light types and malformed type-specific fields", () => {
    const withLight = (light: unknown) => () =>
      new RendererConfig({
        lighting: { lights: [light as never] },
      });

    expectInvalid(
      withLight({ type: "mystery", intensity: 1, color: [1, 1, 1] }),
    );
    expectInvalid(withLight({ type: "", intensity: 1, color: [1, 1, 1] }));
    expectInvalid(
      withLight({ type: "directional", intensity: 1, color: [1, 1, 1] }),
    );
    expectInvalid(
      withLight({
        type: "point",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 1, 0],
      }),
    );
    expectInvalid(
      withLight({
        type: "point",
        intensity: 1,
        color: [1, 1, 1],
        range: 4,
      }),
    );
    expectInvalid(
      withLight({
        type: "point",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 1, 0],
        range: -2,
      }),
    );
    expectInvalid(
      withLight({
        type: "spot",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 1, 0],
        direction: [0, -1, 0],
        range: 10,
        innerConeDegrees: 40,
        outerConeDegrees: 20,
      }),
    );
    expectInvalid(
      withLight({
        type: "spot",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 1, 0],
        direction: [0, -1, 0],
        range: 10,
        innerConeDegrees: 10,
      }),
    );
    expectInvalid(
      withLight({
        type: "rect",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 8, 0],
        right: [1, 0, 0],
        up: [0, 0, 1],
        width: 0,
        height: 4,
        range: 10,
      }),
    );
    expectInvalid(
      withLight({
        type: "rect",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 8, 0],
        right: [1, 0, 0],
        up: [3, 0, 0],
        width: 4,
        height: 4,
        range: 10,
      }),
    );
    expectInvalid(
      withLight({
        type: "spot",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 1, 0],
        direction: [0, -1, 0],
        range: 10,
        innerConeDegrees: 10,
        outerConeDegrees: 30,
        falloff: "bounced",
      }),
    );
    expectInvalid(
      withLight({
        type: "point",
        intensity: 1,
        color: [1, 1, 1],
        position: [0, 1, 0],
        range: 10,
        falloffExponent: 0,
      }),
    );
  });

  it("exposes the five presets in canonical order", () => {
    expect(rendererPresetNames()).toEqual([
      "studio-pbr",
      "outdoor-sun",
      "toon-viz",
      "rainier-showcase",
      "rainier-relief",
    ]);
    expect(Object.isFrozen(rendererPresetNames())).toBe(true);
  });

  it.each(["studio-pbr", "outdoor-sun", "toon-viz", "rainier-showcase", "rainier-relief"] as const)(
    "matches the %s preset snapshot",
    (name) => {
      expect(getRendererPreset(name).toJSON()).toEqual(
        PRESET_SNAPSHOTS[name],
      );
    },
  );

  it("returns independent defensive copies for each preset lookup", () => {
    const first = getRendererPreset("rainier-showcase").toJSON();
    const second = getRendererPreset("rainier-showcase").toJSON();
    expect(first).toEqual(second);
    first.lighting.lights[0]!.intensity = 99;
    first.gi.modes.push("mutated");
    const third = getRendererPreset("rainier-showcase").toJSON();
    expect(third.lighting.lights[0]!.intensity).toBe(4);
    expect(third.gi.modes).toEqual(["ibl"]);
  });

  it("rejects unknown preset names at runtime", () => {
    expectInvalid(() => RendererConfig.preset("bogus" as never));
    expectInvalid(() => RendererConfig.from("bogus" as never));
    expectInvalid(() => getRendererPreset("bogus" as never));
  });
});
