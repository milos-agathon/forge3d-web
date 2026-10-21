import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  LabelPlan,
  KeepoutRegion,
  PriorityClass,
} from "../../src-ts/label-plan.js";
import { FontAtlas, TypographySettings } from "../../src-ts/typography.js";
import { LabelLayer, LabelStyle } from "../../src-ts/labels.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import { Camera } from "../../src-ts/camera.js";
import { glyphOutlineMesh, lineTextMesh } from "../../src-ts/label-mesh.js";
import { labelSeedUnit } from "../../src-ts/label-candidates.js";
import { LABEL_CASES } from "../../src-ts/label-cases.js";
import type {
  LabelPlanOptions,
  LabelPlanData,
  LabelPoint,
} from "../../src-ts/label-types.js";
const native = JSON.parse(
  readFileSync(
    new URL("../fixtures/w13/native-label-plan.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: { source: string; input: LabelPlanOptions; expected: LabelPlanData }[];
};
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "ordering_key")
        .map(([k, v]) => [k, normalize(v)]),
    );
  return typeof value === "number" ? Math.round(value * 1e9) / 1e9 || 0 : value;
}
describe("W13 independent native LabelPlan contracts", () => {
  it.each(native.cases.map((c, i) => ({ ...c, name: `${i} ${c.source}` })))(
    "$name",
    (c) => {
      expect(normalize(LabelPlan.compile(c.input).toJSON())).toEqual(
        normalize(c.expected),
      );
    },
  );
});
let atlas: FontAtlas;
beforeAll(async () => {
  atlas = await FontAtlas.create({
    fonts: ["NotoSans", "NotoSansArabic", "NotoSansDevanagari"].map((id) => ({
      id,
      data: new Uint8Array(
        readFileSync(
          new URL(`../../assets/fonts/${id}-Regular.ttf`, import.meta.url),
        ),
      ),
    })),
  });
});
afterAll(() => atlas?.dispose());
describe("W13 typography and actual font coverage", () => {
  it("shapes Latin ligatures, kerning, Arabic joins and Devanagari clusters deterministically", () => {
    for (const text of ["AV office", "مرحبا", "नमस्ते", "A\nB"]) {
      const a = atlas.shape(text);
      expect(a.diagnostics).toEqual([]);
      expect(a.glyphs.every((g) => g.glyphId > 0)).toBe(true);
      expect(a.width).toBeGreaterThan(0);
      expect(atlas.shape(text)).toEqual(a);
    }
    expect(atlas.shape("office").glyphs.length).toBeLessThan(6);
    expect(atlas.shape("AV").width).toBeLessThan(
      atlas.shape("AV", { kerning: false }).width,
    );
    expect(atlas.shape("नमस्ते").glyphs.length).toBeLessThan(
      Array.from("नमस्ते").length,
    );
    expect(atlas.shape("مرحبا").glyphs.map((g) => g.cluster)).toEqual([
      4, 3, 2, 1, 0,
    ]);
  });
  it("metrics preserve tracking, word spacing, multiline and callout offsets", () => {
    const plain = atlas.shape("AV\nA", {
        fontSize: 20,
        lineHeight: 20,
        kerning: false,
      }),
      spaced = atlas.shape("AV\nA", {
        fontSize: 20,
        lineHeight: 30,
        tracking: 2,
      });
    expect(spaced.height).toBe(60);
    expect(spaced.width).toBeGreaterThan(plain.width);
    expect(spaced.lineCount).toBe(2);
    expect(atlas.shape("A A", { wordSpacing: 2 }).width).toBeGreaterThan(
      atlas.shape("A A").width,
    );
    expect(
      new TypographySettings({
        callout: true,
        calloutOffset: [8, -4],
      }).layoutLabel("Peak\nElevation", [100, 50, 12], atlas).callout
        .label_anchor,
    ).toEqual([108, 46, 12]);
  });
  it("uses deterministic fallback and diagnoses coverage before drawing", () => {
    expect(atlas.fallbackFor("A")).toBe("NotoSans");
    expect(atlas.fallbackFor("م")).toBe("NotoSansArabic");
    expect(atlas.fallbackFor("न")).toBe("NotoSansDevanagari");
    expect(atlas.validateText("A😀")[0]?.details.missing_glyphs).toEqual([
      "😀",
    ]);
    expect(atlas.shape("😀").glyphs).toEqual([]);
  });
  it("rejects corrupt fonts, bounded allocations, tampered bytes and aborts", async () => {
    await expect(
      FontAtlas.create({ fonts: [{ id: "bad", data: new Uint8Array(12) }] }),
    ).rejects.toThrow("font");
    const bytes = new Uint8Array(
      readFileSync(
        new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
      ),
    );
    await expect(
      FontAtlas.create({ fonts: [{ id: "huge", data: bytes }], maxBytes: 12 }),
    ).rejects.toThrow("budget");
    await expect(
      FontAtlas.create({
        fonts: [{ id: "tamper", data: bytes, sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow("integrity");
    const controller = new AbortController();
    controller.abort();
    await expect(
      FontAtlas.create({
        fonts: [{ id: "a", data: bytes }],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
  it("releases native font objects explicitly and idempotently", async () => {
    const a = await FontAtlas.create({
      fonts: [
        {
          id: "a",
          data: new Uint8Array(
            readFileSync(
              new URL(
                "../../assets/fonts/NotoSans-Regular.ttf",
                import.meta.url,
              ),
            ),
          ),
        },
      ],
    });
    expect(a.memoryReport().ownedNativeObjects).toBe(3);
    a.shape("Alive");
    a.dispose();
    a.dispose();
    expect(a.memoryReport()).toEqual({
      fontBytes: 0,
      fontCount: 0,
      ownedNativeObjects: 0,
      disposed: true,
    });
    expect(() => a.shape("Dead")).toThrow("disposed");
  });
});
describe("W13 labels, declutter and scene ownership", () => {
  it("preserves stable IDs across edits, clear, removal and snapshot round trips", () => {
    const layer = new LabelLayer(atlas),
      batch = layer.addLabels([
        { text: "A", position: [50, 50, 0] },
        { text: "", position: [60, 50, 0] },
        { text: "B", position: [90, 50, 0] },
      ]);
    expect(batch.ids).toEqual([1, null, 2]);
    expect(batch.diagnostics[0]?.object_id).toBe("1");
    expect(layer.updateLabel(1, { text: "Edited" })).toBe(true);
    expect(layer.removeLabel(500).ok).toBe(false);
    expect(
      LabelLayer.fromJSON(atlas, JSON.stringify(layer.snapshot())).snapshot(),
    ).toEqual(layer.snapshot());
    layer.clearLabels();
    expect(layer.addLabel("C", [0, 0, 0]).id).toBe(3);
    layer.dispose();
    expect(() => layer.clearLabels()).toThrow("disposed");
  });
  it("renders shaped triangles and removes all attached geometry on disposal", () => {
    const layer = new LabelLayer(atlas),
      scene = Forge3DScene.create();
    layer.addLabel("Actual glyphs", [20, 70, 0]);
    const report = layer.attach(scene, {
      viewport: { width: 300, height: 150 },
    });
    expect(report.accepted).toEqual([1]);
    expect(report.glyphCount).toBeGreaterThan(2);
    expect(report.vertexBytes).toBeGreaterThan(72);
    expect(scene.estimatedGpuBytes()).toBeGreaterThan(0);
    const node = scene.getNodes()[0]?.node;
    if (node?.kind !== "overlay") throw Error("expected overlay");
    expect(node.vertices!.length).toBeGreaterThan(18);
    const copy = scene.copy();
    expect(copy.getNodes()[0]?.node).toEqual(node);
    layer.dispose();
    expect(scene.getNodes()).toEqual([]);
    expect(atlas.disposed).toBe(false);
  });
  it("declutters by priority with deterministic seeded annealing and keepouts", () => {
    const layer = new LabelLayer(atlas);
    layer.addLabel("Low", [80, 80, 0], { priority: 1 });
    layer.addLabel("High", [80, 80, 0], { priority: 5 });
    const opts = { viewport: { width: 300, height: 160 } };
    expect(layer.render(opts).accepted).toEqual([2]);
    expect(layer.render(opts).rejected).toEqual([
      { id: 1, reason: "collision" },
    ]);
    layer.setDeclutterAlgorithm("annealing", { seed: 5, maxIterations: 30 });
    expect(layer.render(opts)).toEqual(layer.render(opts));
    expect(
      layer.render({
        ...opts,
        keepouts: [
          { region_id: "legend", kind: "legend", bounds: [0, 0, 300, 160] },
        ],
      }).accepted,
    ).toEqual([]);
    layer.dispose();
  });
  it("flat lines and repeated paths place real glyphs along tangent rotations", () => {
    const layer = new LabelLayer(atlas),
      r = layer.addLineLabel(
        "AB",
        [
          [20, 60, 0],
          [250, 60, 0],
        ],
        { placement: "along", repeatDistance: 60 },
      );
    expect(r.ok).toBe(true);
    const report = layer.render({ viewport: { width: 300, height: 150 } });
    expect(report.accepted).toEqual([r.id]);
    expect(report.nodes.length).toBeGreaterThan(1);
    expect(report.glyphCount).toBeGreaterThan(2);
    layer.dispose();
  });
  it("curved and elevated line cases return exact native diagnostics", () => {
    const layer = new LabelLayer(atlas),
      curved = layer.addCurvedLabel("River", [
        [0, 0, 0],
        [1, 2, 0],
        [4, 0, 0],
      ]),
      terrain = layer.addLineLabel(
        "Ridge",
        [
          [0, 0, 0],
          [10, 0, 5],
        ],
        {},
        "sample",
      );
    expect(curved.ok).toBe(false);
    expect(curved.diagnostics[0]?.details.feature).toBe("curved labels");
    expect(terrain.ok).toBe(false);
    expect(terrain.diagnostics[0]?.details.feature).toBe(
      "terrain-elevated line labels",
    );
    expect(layer.size).toBe(0);
    layer.dispose();
  });
  it("renders callout leaders, halos and underline, respects zoom and enabled state", () => {
    const layer = new LabelLayer(atlas);
    layer.addCallout("Peak", [40, 100, 0], {
      haloWidth: 1,
      underline: true,
      minZoom: 2,
      maxZoom: 5,
    });
    const opts = { viewport: { width: 300, height: 150 }, zoom: 3 };
    expect(layer.render(opts).nodes.length).toBe(7);
    expect(layer.render({ ...opts, zoom: 1 }).rejected[0]?.reason).toBe(
      "outside_zoom",
    );
    layer.setLabelsEnabled(false);
    expect(layer.render(opts).nodes).toEqual([]);
    layer.dispose();
  });
  it("makes world glyph triangles with depth and actual camera projection", () => {
    const layer = new LabelLayer(atlas),
      camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] });
    layer.addLabel("World", [0, 0, 0], {
      depthTest: true,
      horizonFadeAngle: 0,
    });
    const report = layer.render({
      viewport: { width: 300, height: 150 },
      camera,
    });
    expect(report.accepted).toEqual([1]);
    const node = report.nodes[0];
    if (node?.kind !== "text-mesh") throw Error("expected world glyph mesh");
    // LitVertex includes W11's previous world position for motion capture.
    const bytes = report.nodes.reduce((total, mesh) => {
      if (mesh.kind !== "text-mesh") throw Error("expected world glyph mesh");
      return total + (mesh.vertices!.length / 3) * 84;
    }, 0);
    expect(report.vertexBytes).toBe(bytes);
    const scene = Forge3DScene.create(),
      baseline = scene.estimatedGpuBytes();
    layer.attach(scene, {
      viewport: { width: 300, height: 150 },
      camera,
      maxVertexBytes: bytes,
    });
    expect(scene.estimatedGpuBytes() - baseline).toBe(bytes);
    expect(() =>
      layer.render({
        viewport: { width: 300, height: 150 },
        camera,
        maxVertexBytes: bytes - 1,
      }),
    ).toThrow("Label mesh byte budget exceeded");
    layer.detach(scene);
    scene.dispose();
    layer.addLabel("Behind", [0, 0, 10]);
    expect(
      layer
        .render({ viewport: { width: 300, height: 150 }, camera })
        .rejected.some((r) => r.id === 2 && r.reason === "outside_view"),
    ).toBe(true);
    layer.dispose();
  });
  it("rejects mesh allocation overflow atomically and validates styles", () => {
    const layer = new LabelLayer(atlas),
      scene = Forge3DScene.create();
    layer.addLabel("Budget", [20, 80, 0]);
    expect(() =>
      layer.attach(scene, {
        viewport: { width: 300, height: 150 },
        maxVertexBytes: 1,
      }),
    ).toThrow("budget");
    expect(scene.getNodes()).toEqual([]);
    expect(() => new LabelStyle({ fontSize: NaN })).toThrow();
    layer.dispose();
  });
  it("replays LabelPlan serialization and disallows unknown payload versions/reasons", () => {
    const p = LabelPlan.compile({
      labels: [{ id: "x", text: "X", position: [20, 30, 0] }],
      viewport: [100, 100],
    });
    expect(LabelPlan.fromJSON(p.serialize()).toJSON()).toEqual(p.toJSON());
    expect(p.toExportPayload("pdf").supported).toBe(false);
    expect(p.toRenderPayload("webgpu").supported).toBe(true);
    expect(() =>
      LabelPlan.fromJSON({ ...p.toJSON(), payload_version: 99 }),
    ).toThrow("version");
    expect(
      () =>
        new KeepoutRegion({
          region_id: "a",
          kind: "legend",
          bounds: [NaN, 0, 2, 3],
        }),
    ).toThrow();
    expect(() => new PriorityClass({ name: "x", rank: NaN })).toThrow();
  });
  it("promotes complex shaping only with a prepared FontAtlas", () => {
    const labels = [{ id: "arabic", text: "مرحبا", position: [20, 40, 0] }];
    expect(
      LabelPlan.compile({ labels, viewport: [100, 100] }).rejected[0]?.reason,
    ).toBe("unsupported_geometry_type");
    expect(
      LabelPlan.compile({ labels, viewport: [100, 100], fontAtlas: atlas })
        .accepted,
    ).toHaveLength(1);
  });
});
describe("W13 geometry and manifest boundaries", () => {
  it("keeps holes out of the tessellated glyph", () => {
    const mesh = glyphOutlineMesh([
      { type: "M", values: [0, 0] },
      { type: "L", values: [10, 0] },
      { type: "L", values: [10, 10] },
      { type: "L", values: [0, 10] },
      { type: "Z", values: [] },
      { type: "M", values: [3, 3] },
      { type: "L", values: [3, 7] },
      { type: "L", values: [7, 7] },
      { type: "L", values: [7, 3] },
      { type: "Z", values: [] },
    ]);
    let area = 0;
    for (let i = 0; i < mesh.length; i += 9) {
      const [a, b, , c, d, , e, f] = mesh.slice(i, i + 9);
      area += Math.abs((c! - a!) * (f! - b!) - (d! - b!) * (e! - a!)) / 2;
    }
    expect(area).toBeCloseTo(84);
  });
  it("seeded jitter matches the native SHA256 algorithm", () => {
    expect(labelSeedUnit("123|point|0|radial")).toBeCloseTo(
      0.9103372260470359,
      15,
    );
  });
  it("uses only the exhaustive canonical case outcomes", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../../docs/parity/label-case-contract.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(LABEL_CASES).toEqual(manifest.cases);
    expect(new Set(manifest.cases.map((c: { id: string }) => c.id)).size).toBe(
      manifest.cases.length,
    );
  });
});

describe("W13 review shaping and geometry regressions", () => {
  it("lays out tabs as whitespace while preserving original source clusters", () => {
    const shaped = atlas.shape("A\tB"),
      expanded = atlas.shape("A    B");
    expect(shaped.diagnostics).toEqual([]);
    expect(shaped.width).toBe(expanded.width);
    expect(shaped.glyphs.map((g) => g.cluster)).toEqual([0, 1, 1, 1, 1, 2]);
    expect(shaped.glyphs.every((g) => g.glyphId > 0)).toBe(true);
    expect(shaped.glyphs.slice(1, 5).every((g) => g.path.length === 0)).toBe(
      true,
    );
    expect(atlas.shape("A\r\nB").glyphs.every((g) => g.glyphId > 0)).toBe(true);
  });
  it("positions individual glyphs on both sides of a polyline bend", () => {
    const shape = atlas.shape("WWWW", { fontSize: 20 }),
      width = shape.width;
    const points: LabelPoint[] = [
      [10, 100, 0],
      [10 + width / 2 + 8, 100, 0],
      [10 + width / 2 + 8, 20, 0],
    ];
    const mesh = lineTextMesh(shape, points, width / 2 + 18);
    let horizontal = 0,
      vertical = 0;
    for (let i = 0; i < mesh.length; i += 3) {
      if (mesh[i]! < points[1]![0] - 2) horizontal++;
      if (mesh[i + 1]! < 85) vertical++;
    }
    expect(horizontal).toBeGreaterThan(10);
    expect(vertical).toBeGreaterThan(10);
  });
  it("compiles a 200000-vertex polygon without spreading vertices into the JS stack", () => {
    const ring = Array.from({ length: 200000 }, (_, i) => [
      50 + 30 * Math.cos((i / 200000) * Math.PI * 2),
      50 + 30 * Math.sin((i / 200000) * Math.PI * 2),
    ]);
    ring.push(ring[0]!);
    const p = LabelPlan.compile({
      labels: [
        {
          id: "large",
          text: "Park",
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      ],
      viewport: [100, 100],
    });
    expect(p.accepted[0]?.label_id).toBe("large");
    expect(p.accepted[0]?.candidate.anchor[0]).toBeCloseTo(50, 5);
  });
});

describe("W13 reversed path reading order", () => {
  it.each(["AB", "مرحبا"])(
    "keeps the shaped glyph order for %s on a reversed path",
    (text) => {
      const shape = atlas.shape(text, { fontSize: 20 });
      const forward = lineTextMesh(
        shape,
        [
          [100, 100, 0],
          [300, 100, 0],
        ],
        100,
      );
      const reversed = lineTextMesh(
        shape,
        [
          [300, 100, 0],
          [100, 100, 0],
        ],
        100,
      );
      expect(forward.length).toBeGreaterThan(0);
      // Byte-identical full meshes prove every glyph remains in shaped order.
      expect(reversed).toEqual(forward);
    },
  );
});
