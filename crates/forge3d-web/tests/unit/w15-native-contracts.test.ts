import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { crossCheckNativeHistory } from "./w15-native-history.js";
import * as f from "../../src-ts/index.js";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL("../fixtures/w15/" + name, import.meta.url), "utf8"),
  );
const plane = () => f.generatePrimitive("plane", { resolution: [2, 2] });
describe("W15 historical native contract adaptations", () => {
  it("crease edge positions follow the native smooth and midpoint rules", () => {
    const mesh = {
      positions: new Float32Array([0, 0, 0, 2, 0.2, 0, 2, 1, 0, 0, 1.5, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      uvs: new Float32Array([0, 0, 2, 0.2, 2, 1, 0, 1.5]),
    };
    const nearest = (m: f.MeshBuffers, x: number, y: number) => {
      let distance = Infinity;
      for (let i = 0; i < m.positions.length; i += 3)
        distance = Math.min(
          distance,
          Math.hypot(m.positions[i]! - x, m.positions[i + 1]! - y),
        );
      return distance;
    };
    expect(nearest(f.subdivideMesh(mesh), 1, 0.5875)).toBeLessThan(1e-5);
    expect(
      nearest(f.subdivideMesh(mesh, { creases: [[0, 2]] }), 1, 0.5),
    ).toBeLessThan(1e-5);
  });
  it("historical weld tolerances and collapsed vertex count are preserved", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1e-6, 0, 0]),
      indices = new Uint32Array([0, 1, 2, 3, 2, 1]);
    const result = f.weldMesh({ positions, indices });
    expect(result.mesh.positions.length / 3).toBe(3);
    expect(result.collapsed).toBe(1);
    expect([...result.remap]).toEqual([0, 1, 2, 0]);
    expect(
      f.weldMesh(
        {
          positions: new Float32Array([0, 0, 0, 0, 0, 0]),
          indices: new Uint32Array([0, 1, 1]),
          uvs: new Float32Array([0, 0, 0.5, 0]),
        },
        { uvEpsilon: 1e-3 },
      ).mesh.positions.length / 3,
    ).toBe(2);
  });
  it("miter bevel and round ribbon joins preserve native corner spans and counts", () => {
    const path: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ];
    const span = (m: f.MeshBuffers) =>
      Math.hypot(
        m.positions[6]! - m.positions[9]!,
        m.positions[7]! - m.positions[10]!,
        m.positions[8]! - m.positions[11]!,
      );
    const bevel = f.generateRibbon(path, {
        widthStart: 0.2,
        widthEnd: 0.2,
        joinStyle: "bevel",
      }),
      miter = f.generateRibbon(path, {
        widthStart: 0.2,
        widthEnd: 0.2,
        joinStyle: "miter",
        miterLimit: 8,
      }),
      round = f.generateRibbon(path, {
        widthStart: 0.2,
        widthEnd: 0.2,
        joinStyle: "round",
      });
    expect(span(bevel)).toBeCloseTo(0.2, 5);
    expect(span(miter)).toBeGreaterThan(span(bevel) * 1.05);
    expect(round.positions.length / 3).toBe(6);
    expect(round.indices.length / 3).toBe(4);
  });
  it("MultiPolygonZ exports disjoint surfaces with native counts and normals", () => {
    const ring = (x: number): [number, number, number][] => [
      [x, 0, 0],
      [x + 1, 0, 0],
      [x + 1, 1, 0],
      [x, 1, 0],
    ];
    const mesh = f.meshFromMultiPolygonZ([[ring(0)], [ring(2)]]),
      copy = f.parseObj(f.encodeObj(mesh)).mesh;
    expect(mesh.positions.length / 3).toBe(8);
    expect(copy.indices.length / 3).toBe(4);
    for (let i = 2; i < copy.normals.length; i += 3)
      expect(copy.normals[i]).toBeCloseTo(1, 5);
  });
  it("native CPU instance expansion adapts to owned shared GPU batches", () => {
    const base = f.generatePrimitive("box"),
      translated = f.transformMesh(base, f.makeScatterTransform([1, 0, 0])),
      expanded = f.mergeMeshes([base, translated]);
    expect(expanded.positions.length).toBe(base.positions.length * 2);
    expect(expanded.indices.length).toBe(base.indices.length * 2);
    expect(expanded.positions.slice(0, base.positions.length)).toEqual(
      base.positions,
    );
    expect(expanded.normals.slice(base.normals.length)).toEqual(base.normals);
    for (let i = 0; i < base.positions.length; i += 3)
      expect(translated.positions[i]).toBeCloseTo(base.positions[i]! + 1, 6);
    const layer = new f.MeshLayer(base, {
      transforms: Float32Array.from([
        ...f.MESH_IDENTITY,
        ...f.makeScatterTransform([1, 0, 0]),
      ]),
    });
    expect(layer.toBatch().snapshot().transforms.length).toBe(32);
    layer.dispose();
    expect(layer.cpuBytes).toBe(0);
  });
  it("registered native TBN wrappers adapt to typed attributes and facade exports", () => {
    expect(typeof f.generatePrimitive).toBe("function");
    expect(typeof f.attachMeshTangents).toBe("function");
    for (const [mesh, nv, ni] of [
      [f.generatePrimitive("box"), 24, 36],
      [f.generatePrimitive("plane", { resolution: [3, 3] }), 16, 54],
      [plane(), 9, 24],
    ] as const) {
      const m = f.attachMeshTangents(mesh);
      expect(m.positions.length).toBe(nv * 3);
      expect(m.normals.length).toBe(nv * 3);
      expect(m.uvs.length).toBe(nv * 2);
      expect(m.tangents.length).toBe(nv * 4);
      expect(m.indices.length).toBe(ni);
      for (let i = 0; i < nv; i++) {
        expect(
          Math.hypot(...m.tangents.subarray(i * 4, i * 4 + 3)),
        ).toBeCloseTo(1, 5);
        expect(Math.abs(m.tangents[i * 4 + 3]!)).toBe(1);
      }
    }
    expect(() => f.generatePrimitive("plane", { resolution: [0, 3] })).toThrow(
      f.Forge3DError,
    );
  });
  it("native sample CityJSON contains all five real meshes and BuildingParts", () => {
    const sample = f.parseCityJsonBuildings(
      fixture("native-sample-buildings.city.json"),
    );
    expect(sample.buildingCount).toBe(5);
    expect(sample.totalTriangles).toBeGreaterThan(0);
    for (const b of sample.buildings())
      expect(b.mesh.indices.length).toBeGreaterThan(0);
    sample.dispose();
    const d = fixture("buildings.city.json");
    d.CityObjects.part = {
      ...structuredClone(d.CityObjects.house),
      type: "BuildingPart",
    };
    d.CityObjects.tree = { type: "Vegetation" };
    const layer = f.parseCityJsonBuildings(d, { origin: [1000, 2000, 0] });
    expect(layer.buildings().map((b) => b.id)).toEqual(["house", "part"]);
    expect(layer.maxLod).toBe(2);
    expect(layer.bounds()).toEqual({ min: [0, 0, 0], max: [2, 1.5, 2] });
    layer.dispose();
  });
  it("custom GeoJSON height keys and MultiPolygon IDs retain native geometry", () => {
    const d = fixture("buildings.geojson");
    d.features = [d.features[0]];
    d.features[0].properties.custom = 7;
    const rings = d.features[0].geometry.coordinates;
    d.features[0].geometry = {
      type: "MultiPolygon",
      coordinates: [
        rings,
        rings.map((r: number[][]) => r.map((p) => [p[0]! + 10, p[1]!])),
      ],
    };
    const layer = f.parseGeoJsonBuildings(d, { heightKey: "custom" });
    expect(layer.buildingCount).toBe(2);
    expect(layer.totalTriangles).toBe(24);
    expect(layer.buildings().map((b) => b.id)).toEqual(["house:0", "house:1"]);
    expect(layer.bounds()!.max[2]).toBe(7);
    expect(layer.totalVertices).toBe(48);
    layer.dispose();
  });
  it("all native material value records and differentiation adapt without Python dataclasses", () => {
    const brick = f.buildingMaterialFromName("brick"),
      glass = f.buildingMaterialFromName("glass"),
      steel = f.buildingMaterialFromName("steel"),
      concrete = f.buildingMaterialFromName("concrete"),
      wood = f.buildingMaterialFromName("wood");
    expect(brick.albedo[0]).toBeGreaterThan(brick.albedo[1]);
    expect(brick.roughness).toBeGreaterThan(0.5);
    expect(glass.albedo[0]).toBeLessThan(0.1);
    expect(glass.roughness).toBeLessThan(0.2);
    expect(steel.metallic).toBeGreaterThan(0.5);
    expect(concrete.albedo[0]).toBeGreaterThan(0.4);
    expect(concrete.roughness).toBeGreaterThan(0.5);
    expect(wood.albedo[0]).toBeGreaterThan(wood.albedo[2]);
    const materials = [brick, glass, steel, wood];
    for (let i = 0; i < materials.length; i++)
      for (let j = i + 1; j < materials.length; j++) {
        const a = materials[i]!,
          b = materials[j]!;
        expect(
          a.albedo.reduce((s, x, k) => s + Math.abs(x - b.albedo[k]!), 0) +
            Math.abs(a.roughness - b.roughness) +
            Math.abs(a.metallic - b.metallic),
        ).toBeGreaterThan(0.1);
      }
    const normalize = (material: Partial<f.BuildingMaterial> = {}) => {
      const layer = new f.BuildingLayer([
        { id: "material", mesh: plane(), material },
      ]);
      const value = layer.buildings()[0]!.material;
      layer.dispose();
      return value;
    };
    const custom = {
      albedo: [0.8, 0.2, 0.1] as [number, number, number],
      roughness: 0.9,
      metallic: 0,
      ior: 1.6,
      emissive: 0.5,
    };
    expect(normalize(custom)).toEqual(custom);
    expect(normalize(structuredClone(custom))).toEqual(custom);
    expect(f.buildingMaterialFromName("unknown_material_xyz")).toEqual(
      normalize(),
    );
  });
  it("empty building geometry and missing appearance assets cannot imply success", () => {
    const scene = f.Forge3DScene.create(),
      empty = f.parseGeoJsonBuildings({
        type: "FeatureCollection",
        features: [],
      });
    expect(empty.bounds()).toBeNull();
    expect(empty.validate()).toMatchObject({
      status: "error",
      supportLevel: "placeholder/fallback",
    });
    expect(empty.validate().diagnostics[0]).toMatchObject({
      code: "placeholder_fallback",
      details: { geometry_count: 0 },
    });
    expect(() => empty.addToScene(scene)).toThrow(f.Forge3DError);
    expect(scene.getScatterBatches()).toHaveLength(0);
    const d = fixture("buildings.city.json");
    d.CityObjects.house.geometry[1].texture = { default: {} };
    const layer = f.parseCityJsonBuildings(d);
    expect(layer.validate().diagnostics.map((d) => d.code)).toContain(
      "missing_texture_path",
    );
    expect(() => layer.addToScene(scene)).toThrow(f.Forge3DError);
    empty.dispose();
    layer.dispose();
    scene.dispose();
  });
  it("missing HTTP sources and malformed building formats return typed browser errors", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("missing", { status: 404 }));
    try {
      await expect(
        f.loadBuildings("https://fixture.test/missing.city.json"),
      ).rejects.toMatchObject({ code: "IO_ERROR" });
    } finally {
      fetch.mockRestore();
    }
    expect(() => f.parseCityJsonBuildings({ type: "NotCityJSON" })).toThrow(
      f.Forge3DError,
    );
    await expect(
      f.loadBuildings(new Blob(["invalid JSON"])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      () => new f.BuildingLayer([{ id: "bad", mesh: plane(), height: NaN }]),
    ).toThrow(f.Forge3DError);
  });
});
describe("W15 native audit provenance", () => {
  it.skipIf(spawnSync("git", ["--version"]).status !== 0)(
    "optional history rejects changed bytes and skips unavailable commits",
    () => {
      const path =
        "crates/forge3d-web/tests/fixtures/w15/native/bf8db93233e5/src/geometry/primitives.rs";
      const bytes = readFileSync(
        new URL("../../../../" + path, import.meta.url),
      );
      expect(crossCheckNativeHistory("HEAD", path, bytes)).toBe(true);
      const changed = Buffer.from(bytes);
      changed[0] ^= 1;
      expect(() => crossCheckNativeHistory("HEAD", path, changed)).toThrow(
        "Frozen native bytes differ from Git",
      );
      expect(
        crossCheckNativeHistory(
          "0000000000000000000000000000000000000000",
          path,
          changed,
        ),
      ).toBe(false);
    },
  );

  // Hash every frozen suite and cross-check available Git history without
  // treating filesystem or subprocess scheduling as a runtime latency gate.
  it("pins every native suite and requires concrete browser ports", () => {
    const audit = JSON.parse(
      readFileSync(
        new URL(
          "../../../../docs/parity/w15-native-audit.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const suite of audit.suites) {
      if (suite.importedSuite) {
        const imported = suite.importedSuite;
        const bytes = readFileSync(
          new URL(
            `../fixtures/w15/native/${imported.revision.slice(0, 12)}/${imported.nativePath}`,
            import.meta.url,
          ),
        );
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          imported.sha256,
        );
        crossCheckNativeHistory(imported.revision, imported.nativePath, bytes);
      }
      const source = readFileSync(
        new URL(
          `../fixtures/w15/native/${suite.revision.slice(0, 12)}/${suite.nativePath}`,
          import.meta.url,
        ),
      );
      expect(createHash("sha256").update(source).digest("hex")).toBe(
        suite.sha256,
      );
      crossCheckNativeHistory(suite.revision, suite.nativePath, source);
      expect(suite.ports.length).toBeGreaterThan(0);
      for (const port of suite.ports) {
        const file = readFileSync(
          new URL("../../../../" + port.file, import.meta.url),
          "utf8",
        );
        expect(file).toContain(port.test);
      }
    }
    for (const asset of audit.assets) {
      const bytes = readFileSync(
        new URL("../../../../" + asset.file, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        asset.sha256,
      );
      expect(
        readFileSync(
          new URL(
            `../fixtures/w15/native/${asset.revision.slice(0, 12)}/${asset.nativePath}`,
            import.meta.url,
          ),
        ),
      ).toEqual(bytes);
      crossCheckNativeHistory(asset.revision, asset.nativePath, bytes);
    }
  }, 30_000);
});
