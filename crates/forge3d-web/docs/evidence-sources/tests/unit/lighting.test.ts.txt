import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  DirectionalLightInput,
  LightInput,
  LightingSnapshot,
  PointLightInput,
  RectAreaLightInput,
  SpotLightInput,
} from "../../src-ts/index.js";
import {
  getLightPreset,
  LightCollection,
  lightPresetNames,
} from "../../src-ts/index.js";

const MAX_LIGHT_BYTES = 64 * 112 + 32;

function expectInvalid(factory: () => unknown): Forge3DError {
  try {
    factory();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    return error as Forge3DError;
  }
  throw new Error("expected Forge3DError");
}

function directional(
  overrides: Partial<DirectionalLightInput> = {},
): DirectionalLightInput {
  return {
    type: "directional",
    color: [1, 1, 1],
    intensity: 1,
    direction: [0, -1, 0],
    ...overrides,
  };
}

function point(overrides: Partial<PointLightInput> = {}): PointLightInput {
  return {
    type: "point",
    color: [1, 1, 1],
    intensity: 1,
    position: [0, 0, 0],
    range: 10,
    ...overrides,
  };
}

function spot(overrides: Partial<SpotLightInput> = {}): SpotLightInput {
  return {
    type: "spot",
    color: [1, 1, 1],
    intensity: 1,
    position: [0, 5, 0],
    direction: [0, -1, 0],
    range: 10,
    innerConeDegrees: 10,
    outerConeDegrees: 30,
    ...overrides,
  };
}

function rect(overrides: Partial<RectAreaLightInput> = {}): RectAreaLightInput {
  return {
    type: "rect",
    color: [1, 1, 1],
    intensity: 1,
    position: [0, 8, 0],
    right: [1, 0, 0],
    up: [0, 0, 1],
    width: 16,
    height: 16,
    range: 25,
    ...overrides,
  };
}

function normalized3(
  value: [number, number, number],
): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

describe("LightCollection", () => {
  it("assigns stable monotonically increasing ids that are never reused", () => {
    const lights = new LightCollection();
    const a = lights.add(directional());
    const b = lights.add(point());
    expect(a).toBe(0);
    expect(b).toBe(1);

    expect(lights.remove(a)).toBe(true);
    const c = lights.add(spot());
    expect(c).toBe(2);
    expect(lights.get(a)).toBeUndefined();
    expect(lights.size).toBe(2);

    const other = lights.add(rect());
    expect(other).toBe(3);
  });

  it("stores defensive copies and returns defensive snapshots", () => {
    const lights = new LightCollection();
    const input = point({ color: [1, 0, 0] });
    const id = lights.add(input);
    input.color[0] = 0;
    input.position[0] = 99;

    const stored = lights.get(id)!;
    expect(stored.color).toEqual([1, 0, 0]);
    expect(stored.type === "point" ? stored.position : null).toEqual([
      0, 0, 0,
    ]);

    stored.color[1] = 0.75;
    if (stored.type === "point") {
      stored.position[2] = 42;
    }
    const again = lights.get(id)!;
    expect(again.color).toEqual([1, 0, 0]);
    expect(again.type === "point" ? again.position : null).toEqual([0, 0, 0]);

    const values = lights.values();
    values[0]!.color[2] = 0.1;
    expect(lights.get(id)!.color).toEqual([1, 0, 0]);
  });

  it("rejects a full collection with INVALID_INPUT", () => {
    const lights = new LightCollection(2);
    lights.add(directional());
    lights.add(point());
    const error = expectInvalid(() => lights.add(spot()));
    expect(error.code).toBe("INVALID_INPUT");

    lights.remove(0);
    lights.add(spot());
    expect(lights.size).toBe(2);
  });

  it("validates maxLights at construction", () => {
    for (const value of [0, -1, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectInvalid(() => new LightCollection(value));
    }
    expect(new LightCollection(1).maxLights).toBe(1);
    expect(new LightCollection().maxLights).toBe(64);
    expect(LightCollection.defaults().maxLights).toBe(64);
  });

  it("rejects invalid colors, vectors, ranges, cones, and rect bases", () => {
    const lights = new LightCollection();
    const reject = (light: unknown): void => {
      const error = expectInvalid(() => lights.add(light as LightInput));
      expect(error.code).toBe("INVALID_INPUT");
    };

    reject({ type: "mystery", color: [1, 1, 1], intensity: 1 });
    reject(point({ color: [1.5, 0, 0] }));
    reject(point({ color: [-0.1, 0, 0] }));
    reject(point({ color: [Number.NaN, 0, 0] }));
    reject(point({ color: [1, 0] as never }));
    reject(point({ intensity: -0.5 }));
    reject(point({ intensity: Number.POSITIVE_INFINITY }));
    reject(point({ position: [0, 0] as never }));
    reject(point({ position: [0, Number.NaN, 0] }));
    reject(point({ range: 0 }));
    reject(point({ range: -2 }));
    reject(point({ range: Number.POSITIVE_INFINITY }));
    reject(point({ innerRadius: -1 }));
    reject(point({ innerRadius: 10 }));
    reject(point({ innerRadius: 12 }));
    reject(point({ edgeSoftness: -0.1 }));
    reject(point({ falloffExponent: 0 }));
    reject(point({ falloffExponent: -2 }));
    reject(point({ falloff: "smooth" as never }));
    reject(directional({ direction: [0, 0, 0] }));
    reject(directional({ direction: [0, Number.NaN, 0] }));
    reject(spot({ innerConeDegrees: -1 }));
    reject(spot({ innerConeDegrees: 45, outerConeDegrees: 30 }));
    reject(spot({ outerConeDegrees: 90 }));
    reject(spot({ outerConeDegrees: 120 }));
    reject(spot({ direction: [0, 0, 0] }));
    reject(rect({ width: 0 }));
    reject(rect({ height: -2 }));
    reject(rect({ right: [0, 0, 0] }));
    reject(rect({ up: [0, 0, 0] }));
    reject(rect({ right: [1, 0, 0], up: [2, 0, 0] }));
    reject(rect({ range: 0 }));
    reject({ ...point(), range: undefined });
    expect(lights.size).toBe(0);
    expect(lights.revision).toBe(0);
  });

  it("normalizes directions, defaults, and rect bases in snapshots", () => {
    const lights = new LightCollection();
    const sun = lights.add(directional({ direction: [0, -2, 0] }));
    const storedSun = lights.get(sun)!;
    expect(storedSun).toEqual({
      id: sun,
      type: "directional",
      color: [1, 1, 1],
      intensity: 1,
      enabled: true,
      castsShadow: true,
      direction: [0, -1, 0],
    });

    const lamp = lights.add(point());
    const storedLamp = lights.get(lamp)!;
    expect(storedLamp).toEqual({
      id: lamp,
      type: "point",
      color: [1, 1, 1],
      intensity: 1,
      enabled: true,
      castsShadow: false,
      position: [0, 0, 0],
      range: 10,
      innerRadius: 0,
      edgeSoftness: 0,
      falloff: "inverse-square",
      falloffExponent: 2,
    });

    const panel = lights.add(
      rect({ right: [2, 0, 0], up: [0.5, 1, 0] }),
    );
    const storedPanel = lights.get(panel)!;
    expect(storedPanel.type).toBe("rect");
    if (storedPanel.type === "rect") {
      expect(storedPanel.right).toEqual([1, 0, 0]);
      expect(storedPanel.up[0]).toBeCloseTo(0, 6);
      expect(storedPanel.up[1]).toBeCloseTo(1, 6);
      expect(storedPanel.up[2]).toBeCloseTo(0, 6);
      expect(storedPanel.twoSided).toBe(false);
      expect(storedPanel.edgeSoftness).toBe(0);
      expect(storedPanel.castsShadow).toBe(false);
    }
  });

  it("tracks revision once per successful mutation", () => {
    const lights = new LightCollection();
    expect(lights.revision).toBe(0);

    const id = lights.add(point());
    expect(lights.revision).toBe(1);
    expectInvalid(() => lights.add(point({ range: -1 })));
    expect(lights.revision).toBe(1);

    lights.update(id, point({ intensity: 2 }));
    expect(lights.revision).toBe(2);
    expect(lights.get(id)!.intensity).toBe(2);
    expectInvalid(() => lights.update(id, point({ range: 0 })));
    expect(lights.revision).toBe(2);
    expectInvalid(() => lights.update(999, point()));
    expect(lights.revision).toBe(2);

    expect(lights.remove(id)).toBe(true);
    expect(lights.revision).toBe(3);
    expect(lights.remove(id)).toBe(false);
    expect(lights.revision).toBe(3);

    lights.setExposure(1.4);
    expect(lights.revision).toBe(4);
    lights.setDebugBounds(true);
    expect(lights.revision).toBe(5);
    lights.setAreaLightApproximation({ sampleCount: 8 });
    expect(lights.revision).toBe(6);

    lights.add(point());
    expect(lights.revision).toBe(7);
    lights.clear();
    expect(lights.revision).toBe(8);
    expect(lights.size).toBe(0);
    lights.clear();
    expect(lights.revision).toBe(8);
  });

  it("reports exact effective ranges and point queries", () => {
    const lights = new LightCollection();
    const sun = lights.add(directional());
    const lamp = lights.add(point({ range: 10, edgeSoftness: 2 }));
    const beam = lights.add(spot({ edgeSoftness: 1 }));
    const panel = lights.add(rect({ edgeSoftness: 0 }));

    expect(lights.effectiveRange(sun)).toBe(Number.POSITIVE_INFINITY);
    expect(lights.effectiveRange(lamp)).toBe(12);
    expect(lights.effectiveRange(beam)).toBe(11);
    expect(lights.effectiveRange(panel)).toBe(25);

    expect(lights.affectsPoint(sun, [1e9, -1e9, 0])).toBe(true);
    expect(lights.affectsPoint(lamp, [5, 0, 0])).toBe(true);
    expect(lights.affectsPoint(lamp, [12, 0, 0])).toBe(true);
    expect(lights.affectsPoint(lamp, [12.0001, 0, 0])).toBe(false);

    expect(lights.affectsPoint(beam, [0, 0, 0])).toBe(true);
    const edge = 0.5 * Math.SQRT2;
    expect(lights.affectsPoint(beam, [edge, 5 - edge, 0])).toBe(false);
    expect(lights.affectsPoint(beam, [0, 6, 0])).toBe(false);

    expect(lights.affectsPoint(panel, [0, -10, 0])).toBe(true);
    expect(lights.affectsPoint(panel, [0, 20, 0])).toBe(false);
    expect(lights.affectsPoint(panel, [0, -40, 0])).toBe(false);
    const panelId = lights.add(rect({ twoSided: true }));
    expect(lights.affectsPoint(panelId, [0, 20, 0])).toBe(true);
  });

  it("keeps disabled lights out of point queries", () => {
    const lights = new LightCollection();
    const lamp = lights.add(point({ enabled: false }));
    expect(lights.affectsPoint(lamp, [0, 0, 0])).toBe(false);
    const sun = lights.add(directional({ enabled: false }));
    expect(lights.affectsPoint(sun, [0, 0, 0])).toBe(false);
  });

  it("reports exact finite and unbounded bounds", () => {
    const lights = new LightCollection();
    const sun = lights.add(directional());
    const lamp = lights.add(point({ position: [1, 2, 3], range: 10, edgeSoftness: 2 }));
    const beam = lights.add(spot({ position: [0, 5, 0], range: 10 }));
    const panel = lights.add(rect({ range: 25, edgeSoftness: 0 }));

    expect(lights.bounds(sun)).toEqual({ kind: "unbounded" });
    expect(lights.bounds(lamp)).toEqual({
      kind: "sphere",
      center: [1, 2, 3],
      radius: 12,
    });
    expect(lights.bounds(beam)).toEqual({
      kind: "sphere",
      center: [0, 5, 0],
      radius: 10,
    });
    const panelBounds = lights.bounds(panel);
    expect(panelBounds.kind).toBe("sphere");
    if (panelBounds.kind === "sphere") {
      expect(panelBounds.center).toEqual([0, 8, 0]);
      expect(panelBounds.radius).toBeCloseTo(25 + Math.hypot(8, 8), 6);
    }
  });

  it("rejects queries for unknown lights and malformed points", () => {
    const lights = new LightCollection();
    lights.add(point());
    for (const id of [-1, 99]) {
      expectInvalid(() => lights.effectiveRange(id));
      expectInvalid(() => lights.bounds(id));
      expectInvalid(() => lights.affectsPoint(id, [0, 0, 0]));
    }
    const lamp = 0;
    expectInvalid(() => lights.affectsPoint(lamp, [0, 0] as never));
    expectInvalid(() =>
      lights.affectsPoint(lamp, [0, Number.NaN, 0]),
    );
  });

  it("normalizes and exposes exposure, debug bounds, and area config", () => {
    const lights = new LightCollection();
    const initial = lights.snapshot();
    expect(initial.exposure).toBe(1);
    expect(initial.debugBounds).toBe(false);
    expect(initial.areaLights).toEqual({
      mode: "ltc",
      sampleCount: 4,
      lutSize: 64,
    });

    lights.setExposure(2.5);
    lights.setDebugBounds(true);
    lights.setAreaLightApproximation({ mode: "sampled", sampleCount: 16 });
    const snapshot = lights.snapshot();
    expect(snapshot.exposure).toBe(2.5);
    expect(snapshot.debugBounds).toBe(true);
    expect(snapshot.areaLights).toEqual({
      mode: "sampled",
      sampleCount: 16,
      lutSize: 64,
    });

    expectInvalid(() => lights.setExposure(-1));
    expectInvalid(() => lights.setExposure(Number.NaN));
    expectInvalid(() => lights.setDebugBounds("yes" as never));
    expectInvalid(() =>
      lights.setAreaLightApproximation({ mode: "fits" as never }),
    );
    expectInvalid(() =>
      lights.setAreaLightApproximation({ sampleCount: 2 as never }),
    );
    expectInvalid(() =>
      lights.setAreaLightApproximation({ lutSize: 32 as never }),
    );
  });

  it("produces isolated snapshots and copies", () => {
    const lights = new LightCollection();
    lights.add(directional());
    lights.add(point());
    lights.setExposure(1.7);

    const snapshot = lights.snapshot();
    expect(snapshot.maxLights).toBe(64);
    expect(snapshot.lights).toHaveLength(2);
    snapshot.lights[0]!.color[0] = 0;
    snapshot.areaLights.sampleCount = 1;
    expect(lights.snapshot().lights[0]!.color).toEqual([1, 1, 1]);
    expect(lights.snapshot().areaLights.sampleCount).toBe(4);

    const copy = lights.copy();
    expect(copy.revision).toBe(lights.revision);
    expect(copy.snapshot()).toEqual(lights.snapshot());
    copy.remove(0);
    copy.setExposure(0.5);
    expect(lights.get(0)).toBeDefined();
    expect(lights.snapshot().exposure).toBe(1.7);
  });

  it("restores snapshots through from() while keeping ids monotonic", () => {
    const lights = new LightCollection();
    lights.add(directional());
    const removed = lights.add(point());
    lights.add(spot());
    lights.remove(removed);
    lights.setExposure(1.25);

    const snapshot = lights.snapshot();
    const restored = LightCollection.from(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    const next = restored.add(point());
    expect(next).toBe(3);
    expect(restored.get(0)).toBeDefined();
    expect(restored.get(removed)).toBeUndefined();
  });

  it("rejects malformed snapshots in from()", () => {
    const lights = new LightCollection();
    lights.add(point());
    const valid = lights.snapshot();

    const reject = (mutate: (snapshot: LightingSnapshot) => void): void => {
      const snapshot = JSON.parse(JSON.stringify(valid)) as LightingSnapshot;
      mutate(snapshot);
      expectInvalid(() => LightCollection.from(snapshot));
    };

    reject((snapshot) => {
      snapshot.maxLights = 0;
    });
    reject((snapshot) => {
      snapshot.exposure = -1;
    });
    reject((snapshot) => {
      snapshot.debugBounds = "yes" as never;
    });
    reject((snapshot) => {
      snapshot.areaLights.mode = "fits" as never;
    });
    reject((snapshot) => {
      snapshot.areaLights.sampleCount = 3 as never;
    });
    reject((snapshot) => {
      snapshot.areaLights.lutSize = 32 as never;
    });
    reject((snapshot) => {
      snapshot.lights[0]!.id = -1;
    });
    reject((snapshot) => {
      snapshot.lights[0]!.id = 0.5;
    });
    reject((snapshot) => {
      snapshot.lights = [
        ...snapshot.lights,
        ...snapshot.lights.map((light) => ({ ...light, id: 0 })),
      ];
    });
    reject((snapshot) => {
      snapshot.revision = -1;
    });
  });

  it("matches the exact GPU byte contract", () => {
    expect(new LightCollection().estimatedGpuBytes()).toBe(MAX_LIGHT_BYTES);
    expect(new LightCollection(8).estimatedGpuBytes()).toBe(8 * 112 + 32);
    expect(new LightCollection(1).estimatedGpuBytes()).toBe(144);
  });
});

describe("light presets", () => {
  it("exposes the canonical frozen name list", () => {
    expect(lightPresetNames()).toEqual([
      "spotlight",
      "area-light",
      "ambient-light",
      "candle",
      "street-lamp",
    ]);
    expect(Object.isFrozen(lightPresetNames())).toBe(true);
    expectInvalid(() => getLightPreset("bogus" as never));
  });

  it("matches the five exact preset inputs", () => {
    expect(getLightPreset("spotlight")).toEqual({
      type: "point",
      position: [0, 15, 0],
      intensity: 2,
      range: 15,
      innerRadius: 2,
      edgeSoftness: 0.2,
      falloff: "exponential",
      falloffExponent: 4,
      color: [1, 1, 0.9],
    });
    // Native SoftLightPreset::AreaLight is a soft radial light, not a rect.
    expect(getLightPreset("area-light")).toEqual({
      type: "point",
      position: [0, 8, 0],
      intensity: 1.5,
      range: 25,
      innerRadius: 8,
      edgeSoftness: 3,
      falloff: "quadratic",
      falloffExponent: 1.5,
      color: [1, 0.95, 0.9],
    });
    expect(getLightPreset("ambient-light")).toEqual({
      type: "point",
      position: [0, 20, 0],
      intensity: 0.8,
      range: 50,
      innerRadius: 15,
      edgeSoftness: 5,
      falloff: "linear",
      falloffExponent: 1,
      color: [0.9, 0.95, 1],
    });
    expect(getLightPreset("candle")).toEqual({
      type: "point",
      position: [0, 2, 0],
      intensity: 1.2,
      range: 8,
      innerRadius: 1,
      edgeSoftness: 0.5,
      falloff: "cubic",
      falloffExponent: 3,
      color: [1, 0.7, 0.4],
    });
    expect(getLightPreset("street-lamp")).toEqual({
      type: "point",
      position: [0, 12, 0],
      intensity: 1.8,
      range: 30,
      innerRadius: 5,
      edgeSoftness: 2,
      falloff: "quadratic",
      falloffExponent: 2.5,
      color: [1, 0.9, 0.7],
    });
  });

  it("produces normalized snapshots for every preset", () => {
    const lights = new LightCollection();
    for (const name of lightPresetNames()) {
      const id = lights.add(getLightPreset(name));
      const stored = lights.get(id)!;
      expect(stored.enabled).toBe(true);
      expect(stored.castsShadow).toBe(false);
      expect(stored.id).toBe(id);
      if (stored.type === "rect") {
        expect(stored.twoSided).toBe(false);
      }
    }
    expect(lights.size).toBe(5);
  });

  it("returns defensive preset objects", () => {
    const first = getLightPreset("candle");
    (first as { intensity: number }).intensity = 99;
    expect(getLightPreset("candle").intensity).toBe(1.2);
    const second = getLightPreset("area-light");
    if (second.type === "point") {
      second.position[1] = 0;
    }
    const third = getLightPreset("area-light");
    expect(third.type === "point" ? third.position : null).toEqual([0, 8, 0]);
  });
});

describe("LightCollection.defaults", () => {
  it("contains the normalized terrain key and fill directional lights", () => {
    const lights = LightCollection.defaults();
    expect(lights.size).toBe(2);
    const [key, fill] = lights.values();
    expect(key!.type).toBe("directional");
    expect(fill!.type).toBe("directional");
    if (key!.type === "directional") {
      const expected = normalized3([0.48, -0.78, -0.4]);
      expect(key!.direction[0]).toBeCloseTo(expected[0], 6);
      expect(key!.direction[1]).toBeCloseTo(expected[1], 6);
      expect(key!.direction[2]).toBeCloseTo(expected[2], 6);
    }
    expect(key!.intensity).toBe(3);
    expect(key!.color).toEqual([1, 1, 1]);
    if (fill!.type === "directional") {
      const expected = normalized3([-0.55, -0.45, 0.35]);
      expect(fill!.direction[0]).toBeCloseTo(expected[0], 6);
      expect(fill!.direction[1]).toBeCloseTo(expected[1], 6);
      expect(fill!.direction[2]).toBeCloseTo(expected[2], 6);
    }
    expect(fill!.intensity).toBe(0.36);
    expect(fill!.color).toEqual([1, 1, 1]);
  });

  it("adds only the key light when maxLights is 1", () => {
    const lights = LightCollection.defaults(1);
    expect(lights.size).toBe(1);
    expect(lights.maxLights).toBe(1);
    expect(lights.values()[0]!.intensity).toBe(3);
  });

  it("reports the configured maximum in capacity errors", () => {
    const lights = new LightCollection(1);
    lights.add({
      type: "point",
      color: [1, 1, 1],
      intensity: 1,
      position: [0, 0, 0],
      range: 5,
    });
    expect(() =>
      lights.add({
        type: "point",
        color: [1, 1, 1],
        intensity: 1,
        position: [0, 0, 0],
        range: 5,
      }),
    ).toThrowError(/maximum of 1 lights/);
  });
});
