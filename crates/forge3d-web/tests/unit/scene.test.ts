import { describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  PointLightInput,
  SceneNodeInput,
  TerrainHeightmapInput,
} from "../../src-ts/index.js";
import { ImageBasedLighting } from "../../src-ts/ibl.js";
import { Forge3DScene } from "../../src-ts/scene.js";

const DEFAULT_LIGHTING_BYTES = 64 * 112 + 32;
const DEFAULT_MATERIAL_BYTES = 256 * 64 + 16;
const SCENE_OVERHEAD_BYTES = DEFAULT_LIGHTING_BYTES + DEFAULT_MATERIAL_BYTES;

function pointLight(
  overrides: Partial<PointLightInput> = {},
): PointLightInput {
  return {
    type: "point",
    color: [1, 1, 1],
    intensity: 1,
    position: [0, 0, 0],
    range: 10,
    ...overrides,
  };
}

function terrain(width = 3, height = 3): TerrainHeightmapInput {
  return {
    width,
    height,
    heights: new Float32Array(width * height),
  };
}

function expectInvalid(factory: () => unknown): Forge3DError {
  try {
    factory();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    return error as Forge3DError;
  }
  throw new Error("expected Forge3DError");
}

describe("Forge3DScene", () => {
  it("keeps all five node kinds in parent-before-child traversal", () => {
    const scene = Forge3DScene.create();
    const group = scene.addNode({ kind: "group", name: "root" });
    const terrainId = scene.addTerrain(terrain(), { name: "terrain" });
    const ground = scene.addGroundPlane({
      name: "ground",
      size: [10, 10],
      color: [0.5, 0.5, 0.5, 1],
    });
    const text = scene.addTextMesh({
      name: "label",
      text: "peak",
      size: 12,
      color: [1, 1, 1, 1],
    });
    const overlay = scene.addOverlay({
      name: "hud",
      bounds: [0, 0, 100, 50],
      color: [0, 0, 0, 0.5],
    });
    scene.addNode({
      kind: "custom",
      name: "extra",
      layerType: "points",
    });
    scene.setParent(terrainId, group);
    scene.setParent(text, terrainId);

    const ids = scene.getNodes().map((snapshot) => snapshot.id);
    expect(ids).toEqual([group, terrainId, text, ground, overlay, 5]);
  });

  it("rejects missing, self, and ancestor-cycle parenting", () => {
    const scene = Forge3DScene.create();
    const a = scene.addNode({ kind: "group", name: "a" });
    const b = scene.addNode({ kind: "group", name: "b" });
    const c = scene.addNode({ kind: "group", name: "c" });
    scene.setParent(b, a);
    scene.setParent(c, b);

    expect(expectInvalid(() => scene.setParent(a, c)).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectInvalid(() => scene.setParent(a, a)).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectInvalid(() => scene.setParent(a, 99)).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectInvalid(() => scene.setParent(99)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("reparents without duplicating children and restores roots", () => {
    const scene = Forge3DScene.create();
    const a = scene.addNode({ kind: "group", name: "a" });
    const b = scene.addNode({ kind: "group", name: "b" });
    const c = scene.addNode({ kind: "group", name: "c" });

    scene.setParent(c, a);
    scene.setParent(c, b);
    scene.setParent(c, b);

    expect(scene.getNode(a)!.children).toEqual([]);
    expect(scene.getNode(b)!.children).toEqual([c]);
    expect(scene.getNode(c)!.parent).toBe(b);

    scene.setParent(c);
    expect(scene.getNode(c)!.parent).toBeNull();
    const roots = scene
      .snapshot()
      .nodes.filter((snapshot) => snapshot.parent === null)
      .map((snapshot) => snapshot.id);
    expect(roots).toEqual([a, b, c]);
  });

  it("suppresses invisible subtrees in traversal", () => {
    const scene = Forge3DScene.create();
    const parent = scene.addNode({ kind: "group", name: "p" });
    const child = scene.addNode({ kind: "overlay", name: "c", bounds: [0, 0, 1, 1], color: [0, 0, 0, 1] });
    const sibling = scene.addNode({ kind: "group", name: "s" });
    scene.setParent(child, parent);
    scene.setVisible(parent, false);

    expect(scene.getNodes().map((node) => node.id)).toEqual([sibling]);
    expect(scene.getNode(child)!.visible).toBe(true);
  });

  it("removes subtrees child-before-parent", () => {
    const scene = Forge3DScene.create();
    const a = scene.addNode({ kind: "group", name: "a" });
    const b = scene.addNode({ kind: "group", name: "b" });
    const c = scene.addNode({ kind: "group", name: "c" });
    const d = scene.addNode({ kind: "group", name: "d" });
    scene.setParent(b, a);
    scene.setParent(c, b);
    scene.setParent(d, b);

    expect(scene.removeNode(b)).toEqual([c, d, b]);
    expect(scene.getNode(b)).toBeUndefined();
    expect(scene.getNode(a)!.children).toEqual([]);
    expect(expectInvalid(() => scene.removeNode(b)).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("increments revision exactly once per committed mutation", () => {
    const scene = Forge3DScene.create();
    expect(scene.revision).toBe(0);

    const a = scene.addNode({ kind: "group", name: "a" });
    const b = scene.addNode({ kind: "group", name: "b" });
    expect(scene.revision).toBe(2);

    scene.setParent(b, a);
    expect(scene.revision).toBe(3);
    scene.setParent(b, a);
    expect(scene.revision).toBe(3);
    expectInvalid(() => scene.setParent(b, 42));
    expect(scene.revision).toBe(3);

    scene.setVisible(b, false);
    expect(scene.revision).toBe(4);
    scene.setVisible(b, false);
    expect(scene.revision).toBe(4);

    scene.setTransform(a, { translation: [1, 0, 0] });
    expect(scene.revision).toBe(5);
    expectInvalid(() => scene.setTransform(a, { scale: [0, 1, 1] }));
    expect(scene.revision).toBe(5);

    scene.addPass({ name: "p", kind: "render" });
    expect(scene.revision).toBe(6);
    expectInvalid(() => scene.addPass({ name: "p", kind: "render" }));
    expect(scene.revision).toBe(6);
    expect(scene.removePass("p")).toBe(true);
    expect(scene.revision).toBe(7);
    expect(scene.removePass("p")).toBe(false);
    expect(scene.revision).toBe(7);

    expectInvalid(() => scene.removeNode(999));
    expect(scene.revision).toBe(7);
    scene.removeNode(b);
    expect(scene.revision).toBe(8);
  });

  it("validates transforms and node inputs", () => {
    const scene = Forge3DScene.create();
    const id = scene.addNode({ kind: "group", name: "n" });

    for (const bad of [
      { rotation: [0, 0, 0, 0] },
      { rotation: [0, 0, 0, 2] },
      { rotation: [0, 0, 0, Number.NaN] },
      { scale: [1, 0, 1] },
      { scale: [-1, 1, 1] },
      { translation: [Number.POSITIVE_INFINITY, 0, 0] },
      { translation: [0, 0] },
    ] as const) {
      expectInvalid(() => scene.setTransform(id, bad as never));
    }
    scene.setTransform(id, { rotation: [0, 0, 0, 1] });
    expect(scene.getNode(id)!.transform.rotation).toEqual([0, 0, 0, 1]);

    expectInvalid(() => scene.addNode({ kind: "group", name: "" }));
    expectInvalid(() =>
      scene.addNode({ kind: "custom", name: "c", layerType: "" }),
    );
    expectInvalid(() =>
      scene.addNode({
        kind: "text-mesh",
        name: "t",
        text: "",
        size: 4,
        color: [1, 1, 1, 1],
      }),
    );
    expectInvalid(() =>
      scene.addNode({
        kind: "text-mesh",
        name: "t",
        text: "x",
        size: 0,
        color: [1, 1, 1, 1],
      }),
    );
    expectInvalid(() =>
      scene.addNode({
        kind: "ground-plane",
        name: "g",
        size: [0, 5],
        color: [1, 1, 1, 1],
      }),
    );
    expectInvalid(() =>
      scene.addNode({
        kind: "overlay",
        name: "o",
        bounds: [0, 0, 0, 10],
        color: [1, 1, 1, 1],
      }),
    );
    expectInvalid(() =>
      scene.addNode({
        kind: "overlay",
        name: "o",
        bounds: [0, 0, 5, 10],
        color: [1, 1, 1, 1.5],
      }),
    );
    expectInvalid(() =>
      scene.addNode({ kind: "mystery", name: "m" } as never as SceneNodeInput),
    );
    expectInvalid(() =>
      scene.addNode({ kind: "group", name: "g", materialSlot: "" }),
    );
    expectInvalid(() =>
      scene.addNode({
        kind: "group",
        name: "g",
        materialSlot: 42 as never,
      }),
    );
  });

  it("clones self-referential custom payloads without hanging", () => {
    const scene = Forge3DScene.create();
    const payload: Record<string, unknown> = { label: "cycle" };
    payload["self"] = payload;
    const id = scene.addNode({
      kind: "custom",
      name: "cyclic",
      layerType: "debug",
      payload,
    });

    const snapshot = scene.getNode(id)!;
    expect(snapshot.node.kind).toBe("custom");
    const stored =
      snapshot.node.kind === "custom"
        ? (snapshot.node.payload as Record<string, unknown>)
        : null;
    expect(stored).not.toBe(payload);
    expect(stored!["label"]).toBe("cycle");
    expect(stored!["self"]).toBe(stored);

    payload["label"] = "mutated";
    expect(scene.getNode(id)!.node.kind === "custom" &&
      (scene.getNode(id)!.node as { payload: { label: unknown } }).payload
        .label).toBe("cycle");
  });

  it("clones cyclic payloads when structuredClone is unavailable", () => {
    vi.stubGlobal("structuredClone", () => {
      throw new Error("clone unavailable");
    });
    try {
      const scene = Forge3DScene.create();
      const payload: Record<string, unknown> = { nested: { deep: 1 } };
      payload["self"] = payload;
      const id = scene.addNode({
        kind: "custom",
        name: "cyclic",
        layerType: "debug",
        payload,
      });
      const stored = scene.getNode(id)!.node as {
        payload: Record<string, unknown>;
      };
      expect(stored.payload["self"]).toBe(stored.payload);
      expect(stored.payload["nested"]).not.toBe(payload["nested"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("validates terrain dimensions and heights", () => {
    const scene = Forge3DScene.create();
    expectInvalid(() =>
      scene.addTerrain({ width: 0, height: 4, heights: new Float32Array(0) }),
    );
    expectInvalid(() =>
      scene.addTerrain({ width: 2.5, height: 4, heights: new Float32Array(10) }),
    );
    expectInvalid(() =>
      scene.addTerrain({ width: 2, height: 2, heights: new Float32Array(3) }),
    );
    expectInvalid(() =>
      scene.addTerrain({
        width: 2,
        height: 2,
        heights: new Float32Array([0, Number.POSITIVE_INFINITY, 0, 0]),
      }),
    );
    expectInvalid(() =>
      scene.addTerrain({
        width: 2,
        height: 2,
        heights: new Float32Array([
          Number.NaN,
          Number.NaN,
          Number.NaN,
          Number.NaN,
        ]),
      }),
    );
    expectInvalid(() =>
      scene.addTerrain({
        width: 2,
        height: 2,
        heights: [0, 0, 0, 0] as never,
      }),
    );
  });

  it("accepts NaN and nodata markers as invalid samples", () => {
    const scene = Forge3DScene.create();
    const id = scene.addTerrain(
      {
        width: 2,
        height: 2,
        heights: new Float32Array([0, Number.NaN, -9999, 2]),
        nodata: -9999,
      },
      { name: "terrain" },
    );
    const snapshot = scene.getNode(id)!;
    const stored =
      snapshot.node.kind === "terrain" ? snapshot.node.terrain : null;
    expect(stored?.nodata).toBe(-9999);
    expect(stored?.heights[1]).toBeNaN();

    const nanNodata = Forge3DScene.create();
    nanNodata.addTerrain(
      {
        width: 2,
        height: 2,
        heights: new Float32Array([0, Number.NaN, 1, 2]),
        nodata: Number.NaN,
      },
      { name: "terrain" },
    );
  });

  it("validates terrain metadata and rejects invalid values", () => {
    const scene = Forge3DScene.create();
    const base = (): TerrainHeightmapInput => ({
      width: 2,
      height: 2,
      heights: new Float32Array([0, 1, 2, 3]),
    });
    const reject = (patch: Record<string, unknown>): void => {
      expectInvalid(() =>
        scene.addTerrain({ ...base(), ...patch } as TerrainHeightmapInput),
      );
    };

    reject({ spacing: [0, 1] });
    reject({ spacing: [1, Number.NaN] });
    reject({ spacing: [1] });
    reject({ exaggeration: 0 });
    reject({ exaggeration: Number.POSITIVE_INFINITY });
    reject({ domain: [2, 1] });
    reject({ domain: [0, Number.NaN] });
    reject({ nodata: Number.POSITIVE_INFINITY });
    reject({ crs: "" });
    reject({ crs: 42 });
    reject({ debugView: "normals" });
    reject({
      colorRamp: {
        stops: [
          { position: 0, color: [0, 0, 0] },
          { position: 1, color: [1, 1, 1] },
        ],
      },
      colormap: "viridis",
    });
    reject({ colormap: "not-a-map" });
    reject({ colormap: { stops: [{ position: 0, color: [0, 0, 0] }] } });
    reject({ heightAo: { directions: 0 } });
    reject({ heightAo: { resolutionScale: 2 } });
    reject({ sunVisibility: { mode: "soft", samples: 0 } });
    reject({ sunVisibility: { mode: "hard", samples: 17 } });
    reject({ sunVisibility: { direction: [0, 0, 0] } });

    const id = scene.addTerrain(
      {
        ...base(),
        spacing: [30, 20],
        exaggeration: 2,
        domain: [0, 4],
        nodata: -1,
        crs: "EPSG:32633",
        colormap: "magma",
        heightAo: { enabled: true, directions: 8 },
        sunVisibility: {
          enabled: true,
          mode: "hard",
          samples: 9,
          softness: 2,
          direction: [0.3, 0.7, 0.2],
        },
        debugView: "height-ao",
      },
      { name: "terrain" },
    );
    expect(scene.getNode(id)!.node.kind).toBe("terrain");
  });

  it("preserves terrain metadata defensively through snapshots and copies", () => {
    const scene = Forge3DScene.create();
    const heights = new Float32Array([1, Number.NaN, 3, -9999]);
    const input: TerrainHeightmapInput = {
      width: 2,
      height: 2,
      heights,
      spacing: [30, 20],
      exaggeration: 1.5,
      domain: [0, 8],
      nodata: -9999,
      crs: "EPSG:4326",
      colormap: {
        stops: [
          { position: 0, color: [0, 0, 0] },
          { position: 1, color: [1, 1, 1] },
        ],
      },
      heightAo: { enabled: true, directions: 8 },
      sunVisibility: {
        enabled: true,
        mode: "soft",
        samples: 4,
        direction: [0.3, 0.7, 0.2],
      },
      debugView: "sun-visibility",
    };
    const id = scene.addTerrain(input, { name: "terrain" });
    heights[0] = 42;
    input.spacing![0] = 99;
    (input.colormap as { stops: { position: number }[] }).stops[0]!.position =
      0.5;
    input.sunVisibility!.direction![0] = -9;

    const snapshot = scene.getNode(id)!;
    const stored =
      snapshot.node.kind === "terrain" ? snapshot.node.terrain : null;
    expect(stored?.heights[0]).toBe(1);
    expect(stored?.spacing).toEqual([30, 20]);
    expect(stored?.colormap).toEqual({
      stops: [
        { position: 0, color: [0, 0, 0] },
        { position: 1, color: [1, 1, 1] },
      ],
    });
    expect(stored?.sunVisibility?.direction).toEqual([0.3, 0.7, 0.2]);
    expect(stored?.debugView).toBe("sun-visibility");

    const copied = scene.copy();
    const copiedTerrain = copied.getNode(id)!.node;
    const copiedStored =
      copiedTerrain.kind === "terrain" ? copiedTerrain.terrain : null;
    expect(copiedStored).toEqual(stored);
    expect(copiedStored?.heights).not.toBe(stored?.heights);
  });

  it("prepends implicit passes in canonical kind order", () => {
    const scene = Forge3DScene.create();
    scene.addOverlay({
      name: "hud",
      bounds: [0, 0, 10, 10],
      color: [0, 0, 0, 1],
    });
    scene.addTerrain(terrain(), { name: "terrain" });
    scene.addPass({
      name: "composite",
      kind: "render",
      reads: ["color"],
      writes: ["graded"],
    });

    const plan = scene.getRenderPlan();
    expect(plan.passes).toEqual(["terrain", "overlay", "composite"]);
    expect(plan.resourceLifetimes["color"]).toEqual([0, 2]);
    expect(plan.barriers).toEqual([
      {
        resource: "color",
        beforePass: "composite",
        from: "write",
        to: "read",
      },
    ]);
    expect(plan.resourceLifetimes["graded"]).toEqual([2, 2]);
  });

  it("supports custom ordering and rejects missing or cyclic dependencies", () => {
    const scene = Forge3DScene.create();
    scene.addGroundPlane({
      name: "ground",
      size: [5, 5],
      color: [1, 1, 1, 1],
    });
    scene.addPass({ name: "late", kind: "copy", dependsOn: ["post"] });
    scene.addPass({ name: "post", kind: "render", reads: ["color"] });

    const plan = scene.getRenderPlan();
    expect(plan.passes).toEqual(["ground-plane", "post", "late"]);

    const cyclic = Forge3DScene.create();
    cyclic.addPass({ name: "a", kind: "compute", dependsOn: ["b"] });
    cyclic.addPass({ name: "b", kind: "compute", dependsOn: ["a"] });
    expect(expectInvalid(() => cyclic.getRenderPlan()).code).toBe(
      "INVALID_INPUT",
    );

    const missing = Forge3DScene.create();
    missing.addPass({ name: "a", kind: "render", dependsOn: ["ghost"] });
    expect(expectInvalid(() => missing.getRenderPlan()).code).toBe(
      "INVALID_INPUT",
    );

    const conflict = Forge3DScene.create();
    conflict.addPass({
      name: "a",
      kind: "render",
      reads: ["color"],
      writes: ["color"],
    });
    expect(expectInvalid(() => conflict.getRenderPlan()).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("computes exact deterministic byte estimates", () => {
    const scene = Forge3DScene.create();
    scene.addTerrain(terrain(3, 3), { name: "terrain" });
    scene.addGroundPlane({
      name: "ground",
      size: [4, 4],
      color: [1, 1, 1, 1],
    });
    scene.addTextMesh({
      name: "label",
      text: "abc",
      size: 10,
      color: [1, 1, 1, 1],
    });
    scene.addOverlay({
      name: "hud",
      bounds: [0, 0, 10, 10],
      color: [0, 0, 0, 1],
    });
    scene.addNode({ kind: "group", name: "free" });
    scene.addNode({ kind: "custom", name: "free2", layerType: "x" });

    const expected = 36 + 180 + 96 + 168 + 504 + 144 + SCENE_OVERHEAD_BYTES;
    expect(scene.estimatedGpuBytes()).toBe(expected);
    expect(Forge3DScene.create().estimatedGpuBytes()).toBe(
      SCENE_OVERHEAD_BYTES,
    );
  });

  it("defensively copies nodes, snapshots, and scene copies", () => {
    const scene = Forge3DScene.create();
    const heights = new Float32Array([1, 2, 3, 4]);
    const input = {
      kind: "terrain",
      name: "terrain",
      terrain: { width: 2, height: 2, heights },
    } satisfies SceneNodeInput;
    const id = scene.addNode(input);
    input.terrain.heights[0] = 99;

    const snapshot = scene.getNode(id)!;
    expect(snapshot.node.kind).toBe("terrain");
    const storedHeights =
      snapshot.node.kind === "terrain" ? snapshot.node.terrain.heights : null;
    expect(storedHeights![0]).toBe(1);

    snapshot.children.push(999);
    expect(scene.getNode(id)!.children).toEqual([]);

    const copied = scene.copy();
    expect(copied.revision).toBe(scene.revision);
    copied.setTransform(id, { translation: [5, 0, 0] });
    expect(scene.getNode(id)!.transform.translation).toEqual([0, 0, 0]);
    expect(copied.getNode(id)!.transform.translation).toEqual([5, 0, 0]);

    const snap = scene.snapshot();
    snap.nodes[0]!.children.push(12345);
    expect(scene.getNode(id)!.children).toEqual([]);
    expect(snap.revision).toBe(scene.revision);
  });

  it("keeps getters legal after idempotent dispose", () => {
    const scene = Forge3DScene.create();
    const id = scene.addNode({ kind: "group", name: "a" });
    scene.dispose();
    scene.dispose();

    expect(scene.disposed).toBe(true);
    expect(scene.revision).toBe(1);
    expect(scene.getNode(id)!.id).toBe(id);
    expect(scene.getNodes()).toHaveLength(1);
    expect(scene.snapshot().nodes).toHaveLength(1);
    expect(scene.estimatedGpuBytes()).toBe(SCENE_OVERHEAD_BYTES);
    expect(scene.getRenderPlan().passes).toEqual([]);
    expect(scene.getLights()).toHaveLength(1);

    for (const operation of [
      () => scene.addNode({ kind: "group", name: "b" }),
      () => scene.setParent(id),
      () => scene.setTransform(id, {}),
      () => scene.setVisible(id, false),
      () => scene.removeNode(id),
      () => scene.addPass({ name: "p", kind: "render" }),
      () => scene.removePass("p"),
      () => scene.addLight(pointLight()),
      () => scene.updateLight(0, pointLight()),
      () => scene.removeLight(0),
      () => scene.clearLights(),
      () => scene.setLightingExposure(1.2),
      () => scene.setLightDebugBounds(true),
      () => scene.setAreaLightApproximation({ mode: "sampled" }),
      () => scene.setMaterial("hero", { id: "hero" }),
      () => scene.removeMaterial("hero"),
      () => scene.clearMaterials(),
    ]) {
      try {
        operation();
        throw new Error("expected RUNTIME_DISPOSED");
      } catch (error) {
        expect((error as Forge3DError).code).toBe("RUNTIME_DISPOSED");
      }
    }
  });
});

describe("Forge3DScene lighting", () => {
  it("starts with the default directional key light and can clear it", () => {
    const scene = Forge3DScene.create();
    const lights = scene.getLights();
    expect(lights).toHaveLength(1);
    expect(lights[0]!.type).toBe("directional");
    expect(lights[0]!.intensity).toBe(3);
    expect(lights[0]!.enabled).toBe(true);

    scene.clearLights();
    expect(scene.getLights()).toEqual([]);
    expect(scene.snapshot().lighting.lights).toEqual([]);
    expect(scene.snapshot().lighting.maxLights).toBe(64);
  });

  it("bumps revision exactly once per effective light mutation", () => {
    const scene = Forge3DScene.create();
    const base = scene.revision;

    const id = scene.addLight(pointLight());
    expect(id).toBe(1);
    expect(scene.revision).toBe(base + 1);

    scene.updateLight(id, pointLight({ intensity: 2 }));
    expect(scene.revision).toBe(base + 2);
    expect(scene.getLight(id)!.intensity).toBe(2);

    expectInvalid(() =>
      scene.updateLight(id, pointLight({ range: -1 })),
    );
    expect(scene.revision).toBe(base + 2);
    expectInvalid(() => scene.updateLight(999, pointLight()));
    expect(scene.revision).toBe(base + 2);
    expectInvalid(() =>
      scene.addLight(pointLight({ color: [2, 0, 0] })),
    );
    expect(scene.revision).toBe(base + 2);

    expect(scene.removeLight(id)).toBe(true);
    expect(scene.revision).toBe(base + 3);
    expect(scene.removeLight(id)).toBe(false);
    expect(scene.revision).toBe(base + 3);

    scene.setLightingExposure(1.4);
    expect(scene.revision).toBe(base + 4);
    scene.setLightDebugBounds(true);
    expect(scene.revision).toBe(base + 5);
    scene.setAreaLightApproximation({ sampleCount: 8 });
    expect(scene.revision).toBe(base + 6);

    scene.clearLights();
    expect(scene.revision).toBe(base + 7);
    scene.clearLights();
    expect(scene.revision).toBe(base + 7);
  });

  it("exposes light reads, bounds, and point queries", () => {
    const scene = Forge3DScene.create();
    const lamp = scene.addLight(
      pointLight({ position: [0, 4, 0], range: 6, edgeSoftness: 1 }),
    );
    expect(scene.getLight(lamp)!.type).toBe("point");
    expect(scene.getLightBounds(lamp)).toEqual({
      kind: "sphere",
      center: [0, 4, 0],
      radius: 7,
    });
    expect(scene.lightAffectsPoint(lamp, [0, 10, 0])).toBe(true);
    expect(scene.lightAffectsPoint(lamp, [0, 12, 0])).toBe(false);

    const key = scene.getLights()[0]!;
    expect(scene.getLightBounds(key.id)).toEqual({ kind: "unbounded" });
    expect(scene.lightAffectsPoint(key.id, [100, -50, 3])).toBe(true);

    expectInvalid(() => scene.getLightBounds(999));
    expectInvalid(() => scene.lightAffectsPoint(999, [0, 0, 0]));
    expect(scene.getLight(999)).toBeUndefined();
  });

  it("carries normalized lighting config in snapshots", () => {
    const scene = Forge3DScene.create();
    scene.setLightingExposure(2);
    scene.setLightDebugBounds(true);
    scene.setAreaLightApproximation({ mode: "sampled", sampleCount: 16 });
    const snapshot = scene.snapshot();
    expect(snapshot.lighting.exposure).toBe(2);
    expect(snapshot.lighting.debugBounds).toBe(true);
    expect(snapshot.lighting.areaLights).toEqual({
      mode: "sampled",
      sampleCount: 16,
      lutSize: 64,
    });
    expect(snapshot.lighting.lights).toHaveLength(1);
    expectInvalid(() => scene.setLightingExposure(-1));
    expectInvalid(() =>
      scene.setAreaLightApproximation({ sampleCount: 5 as never }),
    );
  });

  it("isolates lighting across snapshot() and copy()", () => {
    const scene = Forge3DScene.create();
    const lamp = scene.addLight(pointLight({ intensity: 2 }));

    const snapshot = scene.snapshot();
    const stored = snapshot.lighting.lights[1]!;
    expect(stored.id).toBe(lamp);
    if (stored.type === "point") {
      stored.position[0] = 99;
    }
    const reread = scene.getLight(lamp)!;
    expect(reread.type === "point" ? reread.position[0] : null).toBe(0);

    const copied = scene.copy();
    copied.removeLight(lamp);
    copied.setLightingExposure(0.25);
    expect(scene.getLight(lamp)).toBeDefined();
    expect(scene.snapshot().lighting.exposure).toBe(1);
    expect(copied.getLight(lamp)).toBeUndefined();
    expect(copied.snapshot().lighting.lights).toHaveLength(1);
  });

  it("keeps stable light ids across removals", () => {
    const scene = Forge3DScene.create();
    const keyId = scene.getLights()[0]!.id;
    const lamp = scene.addLight(pointLight());
    scene.removeLight(keyId);
    const next = scene.addLight(pointLight());
    expect(next).toBe(2);
    expect(scene.getLights().map((light) => light.id)).toEqual([lamp, next]);
  });
});

describe("Forge3DScene materials", () => {
  it("starts with the default material slot and exposes it", () => {
    const scene = Forge3DScene.create();
    const materials = scene.getMaterials();
    expect(materials).toHaveLength(1);
    expect(materials[0]!.slot).toBe("default");
    expect(materials[0]!.index).toBe(0);
    expect(materials[0]!.material.brdf).toBe("cooktorrance-ggx");
    expect(scene.getMaterial("default")!.roughness).toBe(0.5);
    expect(scene.getMaterialRoute("default").implementation).toBe("exact");
    expect(scene.getMaterial("missing")).toBeUndefined();
  });

  it("bumps revision once per effective material mutation", () => {
    const scene = Forge3DScene.create();
    const base = scene.revision;

    scene.setMaterial("hero", { id: "hero", brdf: "oren-nayar" });
    expect(scene.revision).toBe(base + 1);
    expect(scene.getMaterial("hero")!.brdf).toBe("oren-nayar");

    scene.setMaterial("hero", { id: "hero", brdf: "ward" });
    expect(scene.revision).toBe(base + 2);

    expect(scene.removeMaterial("hero")).toBe(true);
    expect(scene.revision).toBe(base + 3);
    expect(scene.removeMaterial("hero")).toBe(false);
    expect(scene.revision).toBe(base + 3);
    expect(scene.removeMaterial("default")).toBe(false);
    expect(scene.revision).toBe(base + 3);

    scene.clearMaterials();
    expect(scene.revision).toBe(base + 3);
    scene.setMaterial("hero", { id: "hero" });
    scene.clearMaterials();
    expect(scene.revision).toBe(base + 5);
    expect(scene.getMaterials()).toHaveLength(1);

    expectInvalid(() => scene.setMaterial("bad", { id: "" }));
    expectInvalid(() => scene.getMaterialRoute("missing"));
  });

  it("carries materials and node materialSlot in snapshots and copies", () => {
    const scene = Forge3DScene.create();
    scene.setMaterial("hero", {
      id: "hero",
      brdf: "sss",
      baseColor: [0.8, 0.2, 0.2, 1],
    });
    const mesh = Forge3DScene.create();
    const nodeId = scene.addNode({
      kind: "group",
      name: "routed",
      materialSlot: "hero",
    });
    void mesh;

    const snapshot = scene.snapshot();
    expect(snapshot.materials.revision).toBeGreaterThan(0);
    const hero = snapshot.materials.materials.find(
      (entry) => entry.slot === "hero",
    )!;
    expect(hero.material.brdf).toBe("subsurface");
    expect(hero.material.route.effectiveModel).toBe("disney-principled");
    expect(hero.material.route.implementation).toBe("approximation");
    expect(snapshot.nodes[0]!.node.materialSlot).toBe("hero");
    void nodeId;

    hero.material.baseColor[0] = 9;
    expect(scene.getMaterial("hero")!.baseColor[0]).toBe(0.8);

    const copied = scene.copy();
    copied.setMaterial("hero", { id: "hero", brdf: "lambert" });
    expect(scene.getMaterial("hero")!.brdf).toBe("subsurface");
    expect(copied.getMaterial("hero")!.brdf).toBe("lambert");
    expect(copied.getMaterials().find((e) => e.slot === "hero")!.index).toBe(
      hero.index,
    );
  });

  it("includes material bytes in the memory estimate", () => {
    const scene = Forge3DScene.create();
    expect(scene.estimatedGpuBytes()).toBe(SCENE_OVERHEAD_BYTES);
  });
});

describe("Forge3DScene image-based lighting", () => {
  async function lowIbl(): Promise<ImageBasedLighting> {
    return ImageBasedLighting.fromLinear(
      {
        width: 2,
        height: 1,
        data: new Float32Array([1, 0.5, 0.25, 1, 0.2, 0.4, 0.8, 1]),
      },
      { quality: "low", intensity: 0.75 },
    );
  }

  it("defaults to a null IBL snapshot", () => {
    const scene = Forge3DScene.create();
    expect(scene.getImageBasedLighting()).toBeUndefined();
    expect(scene.snapshot().ibl).toBeNull();
  });

  it("stores, snapshots, and clears IBL defensively", async () => {
    const scene = Forge3DScene.create();
    const ibl = await lowIbl();
    const revision = scene.revision;
    scene.setImageBasedLighting(ibl);
    expect(scene.revision).toBe(revision + 1);

    const snapshot = scene.snapshot();
    expect(snapshot.ibl).not.toBeNull();
    expect(snapshot.ibl!.intensity).toBe(0.75);
    expect(snapshot.ibl!.requestedQuality).toBe("low");
    expect(snapshot.ibl!.report.effectiveMode).toBe("runtime-precompute");

    const fetched = scene.getImageBasedLighting();
    expect(fetched).not.toBe(ibl);
    expect(fetched!.snapshot()).toEqual(ibl.snapshot());
    fetched!.snapshot().source.data[0] = 55;
    expect(scene.snapshot().ibl!.source.data[0]).toBe(1);

    scene.setImageBasedLighting(undefined);
    expect(scene.snapshot().ibl).toBeNull();
    expect(scene.getImageBasedLighting()).toBeUndefined();
  });

  it("rejects non-ImageBasedLighting values", () => {
    const scene = Forge3DScene.create();
    expectInvalid(() =>
      scene.setImageBasedLighting({} as ImageBasedLighting),
    );
  });

  it("copies IBL across scene copies", async () => {
    const scene = Forge3DScene.create();
    const ibl = await lowIbl();
    scene.setImageBasedLighting(ibl);
    const copy = scene.copy();
    expect(copy.snapshot().ibl).toEqual(scene.snapshot().ibl);
    copy.setImageBasedLighting(undefined);
    expect(scene.snapshot().ibl).not.toBeNull();
  });

  it("includes IBL bytes in the memory estimate", async () => {
    const scene = Forge3DScene.create();
    const baseline = scene.estimatedGpuBytes();
    scene.setImageBasedLighting(await lowIbl());
    expect(scene.estimatedGpuBytes()).toBeGreaterThan(baseline);
  });
});
