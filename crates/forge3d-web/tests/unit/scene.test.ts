import { describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  SceneNodeInput,
  TerrainHeightmapInput,
} from "../../src-ts/index.js";
import { Forge3DScene } from "../../src-ts/scene.js";

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
        heights: new Float32Array([0, Number.NaN, 0, 0]),
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

    const expected = 36 + 180 + 96 + 168 + 504 + 144;
    expect(scene.estimatedGpuBytes()).toBe(expected);
    expect(Forge3DScene.create().estimatedGpuBytes()).toBe(0);
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
    expect(scene.estimatedGpuBytes()).toBe(0);
    expect(scene.getRenderPlan().passes).toEqual([]);

    for (const operation of [
      () => scene.addNode({ kind: "group", name: "b" }),
      () => scene.setParent(id),
      () => scene.setTransform(id, {}),
      () => scene.setVisible(id, false),
      () => scene.removeNode(id),
      () => scene.addPass({ name: "p", kind: "render" }),
      () => scene.removePass("p"),
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
