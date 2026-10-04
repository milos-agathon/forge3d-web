import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LabelFeatureSource } from "../../src-ts/label-features.js";
import type {
  LabelFeature,
  LabelFeatureOptions,
} from "../../src-ts/label-features.js";
import { LabelLayer, LabelStyle, LabelFlags } from "../../src-ts/labels.js";
import { LabelPlan } from "../../src-ts/label-plan.js";
import { Camera } from "../../src-ts/camera.js";
import { FontAtlas, FontFallbackRange } from "../../src-ts/typography.js";
import {
  declutterLabels,
  LabelCollisionIndex,
} from "../../src-ts/label-declutter.js";
const fontBytes = new Uint8Array(
  readFileSync(
    new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
  ),
);
const oracles = JSON.parse(
  readFileSync(
    new URL("../fixtures/w13/native-label-features.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: { source: string; input: Record<string, any>; expected: unknown }[];
};
describe("Native feature/MapScene label recipe outcomes", () => {
  it.each(oracles.cases.map((c, i) => ({ ...c, name: `${i} ${c.source}` })))(
    "$name",
    (c) => {
      const i = c.input,
        options: LabelFeatureOptions = {
          text: i.text,
          layerId: i.layer_id ?? "labels",
          terrainSampling: i.terrain_sampling ?? "auto",
          ...(i.crs ? { crs: i.crs } : {}),
          ...(i.target_crs ? { targetCrs: i.target_crs } : {}),
          ...(i.glyph_atlas ? { glyphAtlas: i.glyph_atlas } : {}),
          ...(i.metadata ? { metadata: i.metadata } : {}),
          ...(i.typography ? { typography: i.typography } : {}),
          ...(i.terrain_sampler
            ? {
                terrainSampler: {
                  sample: (x, y, z) => ({
                    elevation: x + y + z,
                    source: "unit-test",
                    visible: true,
                  }),
                },
              }
            : {}),
          ...(i.transform_coords
            ? { transformCoords: (points) => points.map(() => [1000, 2000]) }
            : {}),
        };
      expect(
        LabelFeatureSource.fromFeatures(i.features, options).toJSON(),
      ).toEqual(c.expected);
    },
  );
  it("provides public row/style adapters and preserves explicit CRS identity", () => {
    const rows = [
      {
        id: "city-a",
        properties: { name: "Alpha" },
        geometry: { type: "Point", coordinates: [0.5, 0.25] },
      },
    ];
    const a = LabelLayer.fromRows(rows, { crs: "EPSG:3857" });
    expect(a.labels[0]?.text).toBe("Alpha");
    expect(a.metadata.crs).toBe("EPSG:3857");
    expect(
      LabelLayer.fromStyleLayer(rows, { layout: { "text-field": "{name}" } })
        .labels,
    ).toEqual(a.labels);
    expect(() =>
      LabelLayer.fromFeatures(rows, {
        crs: "EPSG:4326",
        targetCrs: "EPSG:3857",
      }),
    ).toThrow("transformCoords");
  });
  it("compiles feature labels and propagates layer-scoped rejection summaries", () => {
    const features: LabelFeature[] = [
        {
          id: "city",
          properties: { name: "Alpha" },
          geometry: { type: "Point", coordinates: [120, 120] },
        },
        {
          id: "park",
          properties: { name: "Park" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [150, 150],
                [190, 150],
                [190, 190],
                [150, 190],
                [150, 150],
              ],
            ],
          },
        },
        {
          id: "blocked-title",
          properties: { name: "Beta" },
          geometry: { type: "Point", coordinates: [24, 24] },
        },
      ],
      source = LabelLayer.fromFeatures(features, { metadata: { seed: 1234 } }),
      options = {
        viewport: [256, 256] as [number, number],
        keepouts: [
          {
            region_id: "title",
            kind: "title",
            bounds: [0, 0, 64, 64] as [number, number, number, number],
            priority: 100,
          },
        ],
      },
      r = source.validate(options);
    expect(r.plan.accepted.map((a) => a.label_id)).toEqual(["city", "park"]);
    expect(r.plan.rejected[0]?.reason).toBe("keepout_region");
    expect(
      r.diagnostics.find((d) => d.code === "label_rejection_summary")?.layer_id,
    ).toBe("labels");
    expect(r.summary.compiled_label_plan).toEqual({
      accepted_count: 2,
      rejected_count: 1,
      seed: 1234,
    });
    expect(source.validate(options).plan.toJSON()).toEqual(r.plan.toJSON());
  });
  it("reports unconfigured line support and glyph gaps before render", () => {
    const source = LabelLayer.fromFeatures(
        [
          {
            id: "road",
            properties: { name: "Road" },
            geometry: {
              type: "LineString",
              coordinates: [
                [0, 0],
                [10, 10],
              ],
            },
          },
          {
            id: "city",
            properties: { name: "Alpha" },
            geometry: { type: "Point", coordinates: [10, 10] },
          },
        ],
        {
          glyphAtlas: { glyphs: Array.from("Road") },
          layerId: "labels.diagnostics",
        },
      ),
      r = source.validate({ viewport: [100, 100] });
    expect(
      r.diagnostics.some(
        (d) =>
          d.object_id === "road" &&
          d.code === "experimental_feature" &&
          d.details.feature === "line labels",
      ),
    ).toBe(true);
    expect(
      r.diagnostics.some(
        (d) => d.object_id === "city" && d.code === "missing_glyphs",
      ),
    ).toBe(true);
  });
});
let atlas: FontAtlas;
beforeAll(async () => {
  atlas = await FontAtlas.create({
    fonts: [{ id: "NotoSans", data: fontBytes }],
  });
});
afterAll(() => atlas?.dispose());
describe("Native public label state, style and fallback contracts", () => {
  it("ports LabelStyle/LabelFlags construction, defaults, mutable fields and representation", () => {
    const s = new LabelStyle(),
      f = new LabelFlags();
    expect(s.fontSize).toBe(14);
    expect(s.color).toEqual([0.1, 0.1, 0.1, 1]);
    expect(s.haloColor).toEqual([1, 1, 1, 0.8]);
    expect(s.haloWidth).toBe(1.5);
    expect([
      s.minDepth,
      s.maxDepth,
      s.depthFade,
      s.minZoom,
      s.horizonFadeAngle,
    ]).toEqual([0, 1, 0, 0, 5]);
    expect(s.maxZoom).toBe(3.4028235e38);
    expect(f).toEqual({ underline: false, smallCaps: false, leader: false });
    s.fontSize = 24;
    s.color = [1, 0, 0, 0.5];
    s.haloWidth = 3;
    s.priority = 10;
    s.minDepth = 0.1;
    s.maxDepth = 0.9;
    s.depthFade = 0.5;
    s.minZoom = 2;
    s.maxZoom = 100;
    s.rotation = 1.57;
    s.offset = [10, -5];
    s.horizonFadeAngle = 15;
    s.flags.underline = true;
    expect(s.toJSON()).toMatchObject({
      fontSize: 24,
      color: [1, 0, 0, 0.5],
      haloWidth: 3,
      priority: 10,
      minDepth: 0.1,
      maxDepth: 0.9,
      depthFade: 0.5,
      minZoom: 2,
      maxZoom: 100,
      rotation: 1.57,
      offset: [10, -5],
      horizonFadeAngle: 15,
      underline: true,
    });
    expect(String(s)).toContain("LabelStyle(size=24");
    expect(
      new LabelStyle({
        fontSize: 20,
        flags: new LabelFlags({ underline: true, leader: true }),
      }).toJSON(),
    ).toMatchObject({ underline: true, leader: true, smallCaps: false });
  });
  it("returns missing-glyph and placeholder diagnostics before allocating IDs", () => {
    const layer = new LabelLayer(atlas);
    expect(layer.addLabel("😀", [0, 0, 0])).toMatchObject({
      ok: false,
      id: null,
      diagnostics: [
        { code: "missing_glyphs", details: { missing_glyphs: ["😀"] } },
      ],
    });
    for (const path of [
      [],
      [[0, 0, 0]],
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
    ])
      expect(
        layer.addLineLabel("Road", path as [number, number, number][]),
      ).toMatchObject({
        ok: false,
        id: null,
        diagnostics: [
          {
            code: "placeholder_fallback",
            details: { feature: "invalid line label path" },
          },
        ],
      });
    expect(layer.addLabel("A", [10, 60, 0]).id).toBe(1);
    layer.dispose();
  });
  it("preserves configuration, stable line/callout IDs, edits and picking through serialization", () => {
    const layer = new LabelLayer(atlas);
    layer.setTypography({
      tracking: 0.25,
      kerning: true,
      lineHeight: 20.8,
      wordSpacing: 2,
    });
    layer.setDeclutterAlgorithm("annealing", { seed: 123, maxIterations: 50 });
    expect(
      layer.addLineLabel("Road", [
        [0, 90, 0],
        [200, 90, 0],
      ]).id,
    ).toBe(1);
    expect(layer.addCallout("Peak", [20, 150, 0]).id).toBe(2);
    expect(
      LabelLayer.fromJSON(atlas, JSON.stringify(layer.snapshot())).snapshot(),
    ).toEqual(layer.snapshot());
    const report = layer.render({ viewport: { width: 400, height: 300 } }),
      node = report.nodes.find((n) => n.name === "label-1");
    expect(node).toBeDefined();
    expect(layer.pick(104, 86)).toBe(1);
    expect(layer.removeLabel(1).ok).toBe(true);
    expect(layer.removeLabel(1)).toMatchObject({
      ok: false,
      id: null,
      diagnostics: [
        {
          code: "placeholder_fallback",
          object_id: "1",
          details: { feature: "remove unknown label" },
        },
      ],
    });
    layer.clearLabels();
    expect(layer.addLabel("New", [0, 0, 0]).id).toBe(3);
    expect(layer.snapshot().typography?.tracking).toBe(0.25);
    layer.dispose();
  });
  it("keeps reversed line text upright and honors depth/horizon fades", () => {
    const layer = new LabelLayer(atlas);
    layer.addLineLabel(
      "W",
      [
        [100, 80, 0],
        [20, 80, 0],
      ],
      { haloWidth: 0 },
    );
    const mesh = layer.render({ viewport: { width: 300, height: 200 } })
      .nodes[0];
    expect(mesh?.kind).toBe("overlay");
    if (mesh?.kind !== "overlay") throw Error("mesh");
    const xs = Array.from(mesh.vertices!).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(60);
    layer.clearLabels();
    const id = layer.addLabel("Horizon", [0, 0, 0]).id,
      camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] });
    expect(
      layer.render({ viewport: { width: 300, height: 200 }, camera }).rejected,
    ).toContainEqual({ id, reason: "horizon_culled" });
    layer.updateLabel(id!, {
      style: { horizonFadeAngle: 0, minDepth: 0, maxDepth: 0.2 },
    });
    expect(
      layer.render({ viewport: { width: 300, height: 200 }, camera }).rejected,
    ).toContainEqual({ id, reason: "outside_depth" });
    layer.dispose();
  });
  it("default Latin restricts coverage; fallback ranges are deterministic and require real glyphs", async () => {
    const a = await FontAtlas.create({
      fonts: [{ id: "NotoSans", data: fontBytes }],
      unicodeRange: { start: 32, end: 127, name: "Basic Latin" },
      fallbacks: [
        new FontFallbackRange("Greek", 0x370, 0x3ff, "NotoSans"),
        new FontFallbackRange("Latin", 0, 127, "NotoSans"),
      ],
    });
    expect([a.fontSize, a.lineHeight, a.baseline]).toEqual([24, 32, 24]);
    expect(a.coverage).toEqual({ start: 32, end: 127, name: "Basic Latin" });
    expect(a.fallbacks.map((r) => r.name)).toEqual(["Latin", "Greek"]);
    expect(a.queryFallback("Ω")?.fontFamily).toBe("NotoSans");
    expect(a.queryFallback("Ж")).toBeUndefined();
    expect(a.covers("Ω")).toBe(true);
    expect(a.covers("Ж")).toBe(false);
    a.dispose();
    const latin = await FontAtlas.create({
      fonts: [{ id: "NotoSans", data: fontBytes }],
      unicodeRange: { start: 32, end: 127, name: "Basic Latin" },
    });
    expect(latin.validateText("Alpha Ω")).toMatchObject([
      {
        code: "unicode_coverage_gap",
        layer_id: null,
        details: { missing_glyphs: ["Ω"] },
      },
    ]);
    latin.dispose();
  });
  it("returns an exact native missing external font diagnostic and handles disposal", async () => {
    const mocked = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("missing", { status: 404 }));
    try {
      const a = await FontAtlas.fromFont("missing-font.ttf");
      expect(a.memoryReport().fontCount).toBe(0);
      expect(a.diagnostics).toMatchObject([
        {
          code: "missing_external_asset",
          layer_id: null,
          object_id: "missing-font.ttf",
          details: { layer_type: "font_atlas", path: "missing-font.ttf" },
        },
      ]);
      expect(a.covers("A")).toBe(false);
      a.dispose();
    } finally {
      mocked.mockRestore();
    }
  });
});
describe("W13 final boundary checks", () => {
  it("keeps terrain line plans diagnostic and never allocates experimental layer IDs", () => {
    const plan = LabelPlan.compile({
      labels: [
        {
          id: "terrain-line",
          text: "Ridge",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 20],
              [100, 20],
            ],
          },
          repeat_distance: 20,
          requires_terrain: true,
        },
      ],
      viewport: [300, 200],
      terrain: { sample: () => 50 },
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]?.reason).toBe("unsupported_geometry_type");
    expect(
      plan.diagnostics.some(
        (d) =>
          d.code === "experimental_feature" &&
          d.details.feature === "terrain-elevated line labels",
      ),
    ).toBe(true);
    const layer = new LabelLayer(atlas);
    expect(layer.addPlan(plan).ids).toEqual({});
    expect(layer.size).toBe(0);
    layer.dispose();
  });
  it("turns a leader candidate into a real callout and preserves arbitrary source IDs", () => {
    const plan = LabelPlan.compile({
        labels: [
          {
            id: "__proto__",
            text: "Peak",
            position: [30, 100, 0],
            placement_preset: "callout",
          },
        ],
        viewport: [300, 200],
      }),
      layer = new LabelLayer(atlas),
      result = layer.addPlan(plan, { haloWidth: 0 });
    expect(Object.keys(result.ids)).toEqual(["__proto__"]);
    expect(result.ids["__proto__"]).toEqual([1]);
    expect(
      layer.render({ viewport: { width: 300, height: 200 } }).nodes.length,
    ).toBe(2);
    layer.dispose();
  });
  it("rejects depth testing without a camera and retains previous picking after budget failure", () => {
    const layer = new LabelLayer(atlas);
    layer.addLabel("A", [30, 70, 0], { haloWidth: 0 });
    layer.render({ viewport: { width: 300, height: 200 } });
    const picked = layer.pick(33, 65);
    expect(picked).toBe(1);
    expect(() =>
      layer.render({
        viewport: { width: 300, height: 200 },
        maxVertexBytes: 1,
      }),
    ).toThrow("budget");
    expect(layer.pick(33, 65)).toBe(picked);
    layer.clearLabels();
    layer.addLabel("Depth", [0, 0, 0], { depthTest: true });
    expect(() =>
      layer.render({ viewport: { width: 300, height: 200 } }),
    ).toThrow("camera");
    layer.dispose();
  });
});

describe("Native declutter and spatial collision integration", () => {
  it("uses a bounded spatial index with deterministic inclusive edge/margin queries", () => {
    const index = new LabelCollisionIndex();
    index.insert(7, [0, 0, 10, 10]);
    index.insert(2, [-1e9, -1e9, 1e9, 1e9]);
    expect(index.query([10, 10, 20, 20])).toEqual([2, 7]);
    expect(index.query([11, 11, 20, 20], 2)).toEqual([2, 7]);
    expect(index.memoryReport().cells).toBe(1);
    index.clear();
    expect(index.memoryReport()).toEqual({
      entries: 0,
      cells: 0,
      estimatedBytes: 0,
    });
  });
  it("ports native priority energy and seed-controlled annealing over the complete set", () => {
    const input = [
        {
          labelId: 1,
          position: [0, 0] as [number, number],
          bounds: [0, 0, 1, 1] as [number, number, number, number],
          priority: 10,
        },
        {
          labelId: 2,
          position: [0.99, 0] as [number, number],
          bounds: [0.99, 0, 1.99, 1] as [number, number, number, number],
          priority: 2,
        },
      ],
      greedy = declutterLabels(input, { margin: 0 }),
      annealed = declutterLabels(input, {
        algorithm: "annealing",
        seed: 42,
        maxIterations: 100,
        margin: 0,
      });
    expect(greedy.visibleLabels).toEqual([1]);
    expect(greedy.totalEnergy).toBe(-10);
    expect(annealed.visibleLabels).toEqual([1, 2]);
    expect(annealed.totalEnergy).toBeCloseTo(-11.9, 5);
    expect(
      declutterLabels(input, {
        algorithm: "annealing",
        seed: 42,
        maxIterations: 100,
        margin: 0,
      }),
    ).toEqual(annealed);
    expect(input.every((c) => !("selected" in c))).toBe(true);
  });
  it("promotes a prepared LabelPlan to drawable IDs and preserves the source plan", () => {
    const plan = LabelPlan.compile({
        labels: [{ id: "point", text: "City", position: [20, 60, 0] }],
        viewport: [300, 200],
        fontAtlas: atlas,
      }),
      before = plan.serialize(),
      layer = new LabelLayer(atlas),
      r = layer.addPlan(plan, { haloWidth: 0 });
    expect(r.ids).toEqual({ point: [1] });
    expect(
      layer.render({ viewport: { width: 300, height: 200 } }).accepted,
    ).toEqual([1]);
    expect(plan.serialize()).toBe(before);
    layer.dispose();
  });
});
