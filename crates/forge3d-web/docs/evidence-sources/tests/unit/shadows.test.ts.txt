import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type { ShadowSnapshot } from "../../src-ts/index.js";
import {
  buildShadowReport,
  CascadedShadowConfig,
  defaultShadowSnapshot,
  normalizeShadowSnapshot,
  parseShadowFilter,
  ShadowConfig,
} from "../../src-ts/shadows.js";
import { Forge3DScene } from "../../src-ts/scene.js";

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

function validShadowSnapshot(): ShadowSnapshot {
  const config = new ShadowConfig({
    enabled: true,
    filter: "pcf",
    mapSize: 512,
  }).snapshot();
  const csm = new CascadedShadowConfig({
    enabled: true,
    cascadeCount: 3,
  }).snapshot();
  return { config, csm, report: buildShadowReport(config, csm, 2) };
}

describe("ShadowConfig", () => {
  it("defaults to disabled pcf with contract values", () => {
    const snapshot = new ShadowConfig().snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.filter).toBe("pcf");
    expect(snapshot.mapSize).toBe(2048);
    expect(snapshot.depthBias).toBe(0.002);
    expect(snapshot.normalBias).toBe(0.02);
    expect(snapshot.slopeBias).toBe(0.01);
    expect(snapshot.softness).toBe(1);
    expect(snapshot.pcssBlockerRadius).toBe(2);
    expect(snapshot.pcssFilterRadius).toBe(4);
    expect(snapshot.lightSize).toBe(0.25);
    expect(snapshot.momentBias).toBe(0.0005);
    expect(snapshot.lightBleedReduction).toBe(0.2);
    expect(snapshot.evsmPositiveExponent).toBe(5);
    expect(snapshot.evsmNegativeExponent).toBe(5);
    expect(snapshot.peterPanningOffset).toBe(0.001);
  });

  it("parses all six filters case-insensitively", () => {
    for (const filter of ["hard", "pcf", "pcss", "vsm", "evsm", "msm"]) {
      expect(new ShadowConfig({ filter: filter.toUpperCase() }).snapshot().filter).toBe(
        filter,
      );
      expect(parseShadowFilter(filter)).toBe(filter);
    }
  });

  it("treats none as a disable alias while keeping the pcf filter", () => {
    const snapshot = new ShadowConfig({
      enabled: true,
      filter: "none",
    }).snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.filter).toBe("pcf");
  });

  it("rejects csm with the pipeline explanation", () => {
    const error = expectCode(
      () => new ShadowConfig({ filter: "csm" }),
      "INVALID_INPUT",
    );
    expect(error.message).toBe(
      "csm is a cascade pipeline, not a shadow filter",
    );
    expectCode(() => parseShadowFilter("CSM"), "INVALID_INPUT");
    expectCode(
      () => new ShadowConfig({ filter: "bloom" }),
      "INVALID_INPUT",
    );
  });

  it("validates map size and numeric ranges", () => {
    for (const mapSize of [128, 1000, 8192, 1.5, NaN]) {
      expectCode(() => new ShadowConfig({ mapSize }), "INVALID_INPUT");
    }
    expectCode(() => new ShadowConfig({ depthBias: -1 }), "INVALID_INPUT");
    expectCode(() => new ShadowConfig({ normalBias: NaN }), "INVALID_INPUT");
    expectCode(() => new ShadowConfig({ lightSize: 0 }), "INVALID_INPUT");
    expectCode(
      () => new ShadowConfig({ lightBleedReduction: 1 }),
      "INVALID_INPUT",
    );
    expectCode(
      () => new ShadowConfig({ evsmPositiveExponent: 0 }),
      "INVALID_INPUT",
    );
    expectCode(
      () => new ShadowConfig({ evsmNegativeExponent: 10.5 }),
      "INVALID_INPUT",
    );
    expectCode(
      () => new ShadowConfig({ peterPanningOffset: -0.1 }),
      "INVALID_INPUT",
    );
  });

  it("reports moment filters and peter-panning safety", () => {
    expect(new ShadowConfig({ filter: "vsm" }).requiresMoments()).toBe(true);
    expect(new ShadowConfig({ filter: "evsm" }).requiresMoments()).toBe(true);
    expect(new ShadowConfig({ filter: "msm" }).requiresMoments()).toBe(true);
    expect(new ShadowConfig({ filter: "pcss" }).requiresMoments()).toBe(false);
    expect(new ShadowConfig().peterPanningSafe()).toBe(true);
    expect(
      new ShadowConfig({ peterPanningOffset: 0 }).peterPanningSafe(),
    ).toBe(false);
    expect(
      new ShadowConfig({ depthBias: 1e-5 }).peterPanningSafe(),
    ).toBe(false);
  });

  it("estimates gpu bytes per the contract", () => {
    expect(new ShadowConfig().estimatedGpuBytes(3)).toBe(0);
    const pcf = new ShadowConfig({ enabled: true, filter: "pcf", mapSize: 1024 });
    expect(pcf.estimatedGpuBytes(2)).toBe(1024 * 1024 * 4 * 2 + 368 + 2 * 64);
    const evsm = new ShadowConfig({
      enabled: true,
      filter: "evsm",
      mapSize: 1024,
    });
    expect(evsm.estimatedGpuBytes(2)).toBe(
      1024 * 1024 * 4 * 2 + 1024 * 1024 * 16 * 2 + 368 + 2 * 64,
    );
  });

  it("rejects out-of-range cascade counts in the byte estimate", () => {
    const config = new ShadowConfig({ enabled: true, mapSize: 256 });
    for (const count of [0, 5, 2.5, Number.NaN, -1]) {
      expectCode(() => config.estimatedGpuBytes(count), "INVALID_INPUT");
    }
    expectCode(
      () => new ShadowConfig().estimatedGpuBytes(0),
      "INVALID_INPUT",
    );
    for (const count of [1, 2, 3, 4]) {
      expect(config.estimatedGpuBytes(count)).toBeGreaterThan(0);
    }
  });

  it("roundtrips snapshots and copies defensively", () => {
    const config = new ShadowConfig({ enabled: true, filter: "pcss" });
    const restored = ShadowConfig.from(config.snapshot());
    expect(restored.snapshot()).toEqual(config.snapshot());
    const copy = config.copy();
    expect(copy.snapshot()).toEqual(config.snapshot());
    const snapshot = config.snapshot();
    snapshot.mapSize = 512;
    expect(config.snapshot().mapSize).toBe(2048);
  });
});

describe("CascadedShadowConfig", () => {
  it("defaults to disabled three-cascade configuration", () => {
    const snapshot = new CascadedShadowConfig().snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.cascadeCount).toBe(3);
    expect(snapshot.maxDistance).toBe(200);
    expect(snapshot.splitLambda).toBe(0.75);
    expect(snapshot.blendRange).toBe(0.1);
    expect(snapshot.stabilize).toBe(true);
    expect(snapshot.debugView).toBe("none");
  });

  it("validates cascade count, distance, lambda, blend, and debug view", () => {
    expectCode(
      () => new CascadedShadowConfig({ enabled: true, cascadeCount: 5 as 4 }),
      "INVALID_INPUT",
    );
    expectCode(
      () => new CascadedShadowConfig({ maxDistance: 0 }),
      "INVALID_INPUT",
    );
    expectCode(
      () => new CascadedShadowConfig({ splitLambda: 1.2 }),
      "INVALID_INPUT",
    );
    expectCode(
      () => new CascadedShadowConfig({ blendRange: -0.1 }),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        new CascadedShadowConfig({ debugView: "Cascade" as "cascades" }),
      "INVALID_INPUT",
    );
  });

  it("computes disabled splits as [near, min(far, maxDistance)]", () => {
    const csm = new CascadedShadowConfig();
    expect(csm.calculateSplits(0.5, 500)).toEqual([0.5, 200]);
    expect(csm.calculateSplits(0.5, 50)).toEqual([0.5, 50]);
    expectCode(() => csm.calculateSplits(0, 100), "INVALID_INPUT");
    expectCode(() => csm.calculateSplits(10, 10), "INVALID_INPUT");
  });

  it("rejects splits when the shadow far plane is at or below near", () => {
    const disabled = new CascadedShadowConfig({ maxDistance: 5 });
    expectCode(() => disabled.calculateSplits(10, 100), "INVALID_INPUT");
    const enabled = new CascadedShadowConfig({
      enabled: true,
      cascadeCount: 3,
      maxDistance: 5,
    });
    expectCode(() => enabled.calculateSplits(10, 100), "INVALID_INPUT");
  });

  it("matches the lead-checked practical split scheme literal", () => {
    const csm = new CascadedShadowConfig({ enabled: true, cascadeCount: 4 });
    const splits = csm.calculateSplits(0.1, 100);
    const expected = [
      0.1, 6.690505993892763, 14.884208245126285, 32.09334557529192, 100,
    ];
    expect(splits.length).toBe(5);
    for (let index = 0; index < expected.length; index += 1) {
      expect(Math.abs(splits[index] - expected[index])).toBeLessThanOrEqual(1e-6);
    }
  });

  it("stabilizes bounds to the lead-checked literal", () => {
    const csm = new CascadedShadowConfig();
    const bounds = csm.stabilizeBounds(
      [-10.3, -5.1, -20],
      [11.7, 6.9, 30],
      1024,
    );
    expect(bounds.texelSize).toBeCloseTo(0.021484375, 9);
    expect(bounds.min[0]).toBeCloseTo(-10.291015625, 6);
    expect(bounds.min[1]).toBeCloseTo(-10.09765625, 6);
    expect(bounds.max[0]).toBeCloseTo(11.708984375, 6);
    expect(bounds.max[1]).toBeCloseTo(11.90234375, 6);
    expect(bounds.min[2]).toBe(-20);
    expect(bounds.max[2]).toBe(30);
  });
});

describe("ShadowSnapshot validation", () => {
  it("accepts a consistent snapshot", () => {
    const snapshot = validShadowSnapshot();
    expect(normalizeShadowSnapshot(snapshot)).toEqual(snapshot);
    expect(defaultShadowSnapshot().config.enabled).toBe(false);
    expect(normalizeShadowSnapshot(defaultShadowSnapshot()).report.casterLightId).toBeNull();
  });

  it("rejects report/config mismatches", () => {
    const base = validShadowSnapshot();
    const tampered = (mutate: (snapshot: ShadowSnapshot) => void) => {
      const snapshot = JSON.parse(JSON.stringify(base)) as ShadowSnapshot;
      mutate(snapshot);
      return snapshot;
    };
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            s.report.requestedFilter = "vsm";
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            s.report.requestedMapSize = 1024;
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            s.report.csmEnabled = false;
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            s.report.cascadeCount = 2;
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            s.report.momentFormat = "rgba32float";
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            (s.report as { casterLightId: unknown }).casterLightId = "0";
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            (s as { report: unknown }).report = "broken";
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            (s.config as { filter: string }).filter = "none";
          }),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        normalizeShadowSnapshot(
          tampered((s) => {
            (s.csm as { debugView: string }).debugView = "Cascade";
          }),
        ),
      "INVALID_INPUT",
    );
  });
});

describe("effective csm reporting", () => {
  it("reports no cascades while shadows are disabled even with csm enabled", () => {
    const config = new ShadowConfig({ enabled: false, filter: "pcf" }).snapshot();
    const csm = new CascadedShadowConfig({ enabled: true, cascadeCount: 2 }).snapshot();
    const report = buildShadowReport(config, csm, 1);
    expect(report.reason).toBe("shadows disabled");
    expect(report.csmEnabled).toBe(false);
    expect(report.cascadeCount).toBe(1);
    expect(normalizeShadowSnapshot({ config, csm, report }).report).toEqual(report);
    expectCode(
      () =>
        normalizeShadowSnapshot({
          config,
          csm,
          report: { ...report, csmEnabled: true, cascadeCount: 2 },
        }),
      "INVALID_INPUT",
    );
  });

  it("reports the configured cascades once shadows are enabled", () => {
    const config = new ShadowConfig({ enabled: true, filter: "pcf" }).snapshot();
    const csm = new CascadedShadowConfig({ enabled: true, cascadeCount: 2 }).snapshot();
    const report = buildShadowReport(config, csm, 1);
    expect(report.csmEnabled).toBe(true);
    expect(report.cascadeCount).toBe(2);
  });
});

describe("Forge3DScene shadows", () => {
  it("defaults to disabled shadows in the snapshot", () => {
    const scene = Forge3DScene.create();
    const snapshot = scene.snapshot();
    expect(snapshot.shadows.config.enabled).toBe(false);
    expect(snapshot.shadows.csm.enabled).toBe(false);
    expect(snapshot.shadows.report.casterLightId).toBeNull();
    expect(snapshot.shadows.report.momentFormat).toBe("none");
    expect(snapshot.shadows.report.reason).toBe("shadows disabled");
  });

  it("tracks set/get/copy and cascade info", () => {
    const scene = Forge3DScene.create();
    scene.setShadows(
      { enabled: true, filter: "pcf", mapSize: 256 },
      { enabled: true, cascadeCount: 3 },
    );
    const { config, csm } = scene.getShadows();
    expect(config.snapshot().filter).toBe("pcf");
    expect(csm.snapshot().cascadeCount).toBe(3);
    const info = scene.getShadowCascadeInfo(0.1, 100);
    expect(info.length).toBe(3);
    expect(info[0].near).toBe(0.1);
    expect(info[2].far).toBe(100);
    expect(info[0].texelSize).toBeGreaterThan(0);

    const copy = scene.copy();
    expect(copy.snapshot().shadows.config.filter).toBe("pcf");
    scene.setShadows({ enabled: false });
    expect(copy.snapshot().shadows.config.enabled).toBe(true);
  });

  it("reports the first enabled castsShadow directional light", () => {
    const scene = Forge3DScene.create();
    const snapshot = scene.snapshot();
    const caster = snapshot.lighting.lights.find(
      (light) =>
        light.enabled && light.castsShadow && light.type === "directional",
    );
    scene.setShadows({ enabled: true, filter: "pcf", mapSize: 256 });
    const report = scene.getShadowReport();
    expect(report.effectiveFilter).toBe("pcf");
    expect(report.momentFormat).toBe("none");
    if (caster === undefined) {
      expect(report.casterLightId).toBeNull();
      expect(report.reason).toBe("no shadow-casting directional light");
    } else {
      expect(report.casterLightId).toBe(caster.id);
      expect(report.reason).toBe("requested configuration");
    }
  });

  it("includes shadow bytes in the memory estimate only when enabled", () => {
    const scene = Forge3DScene.create();
    const baseline = scene.estimatedGpuBytes();
    scene.setShadows({ enabled: true, filter: "vsm", mapSize: 256 });
    const growth = scene.estimatedGpuBytes() - baseline;
    expect(growth).toBe(256 * 256 * 4 + 256 * 256 * 16 + 368 + 64);
  });
});
