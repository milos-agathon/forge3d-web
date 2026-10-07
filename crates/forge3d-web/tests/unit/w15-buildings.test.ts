import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as f from "../../src-ts/index.js";
const bytes = (name: string) =>
    new Uint8Array(
      readFileSync(new URL("../fixtures/w15/" + name, import.meta.url)),
    ),
  doc = (name: string) => JSON.parse(new TextDecoder().decode(bytes(name)));
describe("W15 building geometry and native diagnostic contracts", () => {
  it("vacant material reuse never collides with a live GPU slot",()=>{
    const scene=f.Forge3DScene.create();for(let i=1;i<256;i++)scene.setMaterial(`slot-${i}`,{id:`slot-${i}`});scene.removeMaterial("slot-1");scene.removeMaterial("slot-3");scene.setMaterial("first-reuse",{id:"first-reuse"});scene.setMaterial("second-reuse",{id:"second-reuse"});const entries=scene.getMaterials();expect(new Set(entries.map(m=>m.index)).size).toBe(256);expect(entries.find(m=>m.slot==="slot-2")!.index).toBe(2);expect(entries.find(m=>m.slot==="first-reuse")!.index).toBe(1);expect(entries.find(m=>m.slot==="second-reuse")!.index).toBe(3);scene.dispose();
  });

  it("building replacement and material-slot exhaustion retain valid indices and atomicity", () => {
    const scene = f.Forge3DScene.create(),
      layer = f.parseGeoJsonBuildings(doc("buildings.geojson"));
    for (let i = 0; i < 270; i++) {
      scene.setMaterial("temporary", { id: "temporary" });
      scene.removeMaterial("temporary");
    }
    layer.addToScene(scene);
    layer.addToScene(scene);
    expect(scene.getScatterBatches()).toHaveLength(2);
    for (const batch of scene.getScatterBatches())
      expect(
        scene
          .getMaterials()
          .some(
            (m) => m.index === batch.materialIndex && m.slot === batch.name,
          ),
      ).toBe(true);
    const snapshot = scene.snapshot();
    expect(() =>
      layer.addToScene(scene, { lodRatios: [1, 0.5], lodDistances: [-1] }),
    ).toThrow(f.Forge3DError);
    expect(scene.snapshot()).toEqual(snapshot);
    scene.dispose();
    layer.dispose();
  });
  it("CityJSON passes decoded quantized vertices to reprojection before local-origin subtraction", async () => {
    const d = doc("buildings.city.json");
    let input: number[][] = [];
    const transformer = {
      async transformCoords(points: number[][]) {
        input = points;
        return points.map((p) => [p[0]! + 10, p[1]! + 20, p[2]!]);
      },
    } as unknown as f.CrsTransformer;
    const layer = await f.loadBuildings(new Blob([JSON.stringify(d)]), {
      crs: "EPSG:28992",
      targetCrs: "EPSG:32632",
      transformer,
      origin: [1010, 2020, 0],
    });
    expect(input[0]).toEqual([1000, 2000, 0]);
    expect(layer.crs).toBe("EPSG:32632");
    expect(layer.bounds()).toEqual({ min: [0, 0, 0], max: [2, 1.5, 2] });
    layer.dispose();
  });
  it("CityJSON and glTF texture requests automatically block building output", async () => {
    const city = doc("buildings.city.json");
    city.CityObjects.house.geometry[1].texture = { default: { values: [] } };
    city.appearance = {
      textures: [{ image: "facade.png" }],
      "vertices-texture": [[0, 0]],
    };
    expect(f.parseCityJsonBuildings(city).validate().status).toBe("error");
    const asset = await f.decodeGltf(bytes("triangle.glb"));
    (asset.materials[0] as any).pbrMetallicRoughness.baseColorTexture = {
      index: 0,
    };
    const layer = f.BuildingLayer.fromGltf(asset),
      scene = f.Forge3DScene.create();
    expect(layer.validate().texturedMaterialStatus).toBe("unsupported");
    expect(() => layer.addToScene(scene)).toThrow(f.Forge3DError);
    expect(scene.getScatterBatches()).toHaveLength(0);
    scene.dispose();
    layer.dispose();
  });
  it("GeoJSON buildings are actual indexed volumes with stable IDs/materials", () => {
    const layer = f.parseGeoJsonBuildings(doc("buildings.geojson"));
    expect(layer.buildingCount).toBe(2);
    expect(layer.totalVertices).toBe(48);
    expect(layer.totalTriangles).toBe(24);
    expect(layer.buildings().map((b) => b.id)).toEqual(["house", "office"]);
    expect(layer.buildings()[0]!.roofType).toBe("gabled");
    expect(layer.buildings()[0]!.material.albedo).toEqual([0.55, 0.25, 0.18]);
    expect(layer.bounds()).toEqual({ min: [0, 0, 0], max: [8, 3, 4] });
    expect(layer.maxLod).toBe(1);
  });
  it("CityJSON transform/CRS/highest LOD/source axes are exact", () => {
    const layer = f.parseCityJsonBuildings(doc("buildings.city.json"), {
      origin: [1000, 2000, 0],
    });
    expect(layer.buildingCount).toBe(1);
    expect(layer.maxLod).toBe(2);
    expect(layer.crs).toBe("EPSG:28992");
    expect(layer.totalVertices).toBe(24);
    expect(layer.totalTriangles).toBe(12);
    expect(layer.bounds()).toEqual({ min: [0, 0, 0], max: [2, 1.5, 2] });
    expect(layer.buildings()[0]!.height).toBe(2);
  });
  it("CityJSON rejects corrupt indices/transforms/unsupported geometry structurally", () => {
    for (const edit of [
      (d: any) => (d.vertices[0] = ["bad", 0, 0]),
      (d: any) =>
        (d.CityObjects.house.geometry[1].boundaries[0][0][0][0] = 9999),
      (d: any) => (d.CityObjects.house.geometry[1].type = "MultiPoint"),
    ]) {
      const d = doc("buildings.city.json");
      edit(d);
      expect(() => f.parseCityJsonBuildings(d)).toThrow(f.Forge3DError);
    }
  });
  it("MultiPolygonZ handles non-horizontal surfaces, holes and exact source elevations", () => {
    const m = f.meshFromMultiPolygonZ([
      [
        [
          [0, 0, 2],
          [2, 0, 2],
          [2, 0, 5],
          [0, 0, 5],
        ],
      ],
    ]);
    expect(m.positions.length / 3).toBe(4);
    expect(m.indices.length / 3).toBe(2);
    expect(f.meshBounds(m)).toEqual({ min: [0, 0, 2], max: [2, 0, 5] });
  });
  for (const roof of [
    "flat",
    "gabled",
    "hipped",
    "pyramidal",
    "dome",
    "mansard",
    "shed",
    "gambrel",
    "onion",
    "skillion",
  ] as const)
    it(`native roof inference ${roof}`, () =>
      expect(
        f.inferRoofType({
          "roof:shape": roof.toUpperCase(),
          building: "warehouse",
        }),
      ).toBe(roof));
  it("native roof defaults, priority, aliases, and Orthodox inference", () => {
    expect(f.inferRoofType({ "roof:shape": "lean-to" })).toBe("shed");
    expect(f.inferRoofType({ building: "house" })).toBe("gabled");
    expect(
      f.inferRoofType({
        building: "church",
        religion: "christian",
        denomination: "russian_orthodox",
      }),
    ).toBe("onion");
    expect(f.inferRoofType({ building: "warehouse" })).toBe("flat");
    expect(f.inferRoofType({})).toBe("flat");
  });
  it("native scalar presets, inference and color parsing", () => {
    expect(f.buildingMaterialFromName("steel")).toMatchObject({
      roughness: 0.35,
      metallic: 0.9,
      ior: 2.5,
    });
    expect(
      f.buildingMaterialFromTags({
        "building:material": "brick",
        building: "office",
      }).albedo,
    ).toEqual([0.55, 0.25, 0.18]);
    expect(f.buildingMaterialFromTags({ building: "office" }).roughness).toBe(
      0.1,
    );
    expect(f.roofMaterialFromTags({ building: "house" }).albedo).toEqual([
      0.6, 0.3, 0.15,
    ]);
    expect(f.parseBuildingColor("#abc")).toEqual([
      170 / 255,
      187 / 255,
      204 / 255,
    ]);
    expect(f.buildingMaterialFromName("unknown")).toMatchObject({
      roughness: 0.6,
      metallic: 0,
    });
  });
  it("exact missing path/UV/format/scalar-fallback diagnostics never imply success", () => {
    const requests = doc("texture-diagnostics.json"),
      r = f.diagnoseBuildingTextures(requests);
    expect(r.status).toBe("error");
    expect(r.texturedMaterialStatus).toBe("placeholder/fallback");
    expect(r.supportLevel).toBe("placeholder/fallback");
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "missing_texture_path",
      "missing_uvs",
      "unsupported_texture_format",
      "placeholder_fallback",
    ]);
    expect(
      r.diagnostics.find((d) => d.code === "unsupported_texture_format")!
        .details.format,
    ).toBe("ktx2");
    expect(r.diagnostics.every((d) => d.objectId === "building-1")).toBe(true);
  });
  it("valid assets/UVs still diagnose unsupported textured PBR; Pro is explicit", () => {
    const requests = [
        {
          materialId: "facade",
          objectId: "building-1",
          albedoTexture: "facade.png",
          uvAvailable: true,
          assetAvailable: true,
        },
      ],
      r = f.diagnoseBuildingTextures(requests, true);
    expect(r.status).toBe("error");
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "pro_gated_path",
      "unsupported_feature",
    ]);
    expect(r.unsupportedFeatures).toEqual({
      "buildings.pro_gated_path": "Pro-gated",
      "buildings.textured_pbr": "unsupported",
    });
    expect(r.diagnostics[1]!.details.feature).toBe(
      "building textured PBR render path",
    );
  });
  it("blocking building diagnostics prevent scene mutation and scalar fallback", () => {
    const scene = f.Forge3DScene.create(),
      layer = f.parseGeoJsonBuildings(doc("buildings.geojson"), {
        textures: doc("texture-diagnostics.json"),
      }),
      before = scene.snapshot();
    expect(() => layer.addToScene(scene)).toThrow();
    expect(scene.snapshot()).toEqual(before);
    scene.dispose();
    layer.dispose();
  });
  it("scalar scene materials, Y-up conversion, LOD and instancing are concrete", () => {
    const scene = f.Forge3DScene.create(),
      layer = f.parseGeoJsonBuildings(doc("buildings.geojson"));
    layer.addToScene(scene, {
      lodRatios: [1, 0.5],
      lodDistances: [10],
      transforms: new Float32Array([...f.MESH_IDENTITY, ...f.MESH_IDENTITY]),
    });
    const batches = scene.getScatterBatches();
    expect(batches.length).toBe(2);
    expect(batches[0]!.materialIndex).toBe(1);
    expect(batches[1]!.materialIndex).toBe(2);
    expect(batches[0]!.transforms.length).toBe(32);
    expect(batches[0]!.bounds.max[1]).toBe(4);
    expect(scene.getMaterial("buildings:house")?.roughness).toBe(0.75);
    expect(scene.getMaterial("buildings:office")?.roughness).toBe(0.1);
    scene.dispose();
    layer.dispose();
    expect(layer.cpuBytes).toBe(0);
    expect(() => layer.buildings()).toThrow();
  });
  it("gltf building bridge retains imported geometry and scalar factors", async () => {
    const asset = await f.decodeGltf(bytes("triangle.glb")),
      layer = f.BuildingLayer.fromGltf(asset);
    expect(layer.totalTriangles).toBe(1);
    expect(layer.buildings()[0]!.material.metallic).toBe(0.6);
    layer.dispose();
  });
  it("source APIs are cancellable and public 3D Tiles incomplete status stays truthful", async () => {
    const layer = await f.loadBuildings(new Blob([bytes("buildings.geojson")]));
    expect(layer.totalTriangles).toBe(24);
    layer.dispose();
    const c = new AbortController();
    c.abort();
    await expect(
      f.loadBuildings(new Blob(), { signal: c.signal }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(
      f.loadBuildingTilesMetadata(new Blob(["{}"])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const metadata = await f.loadBuildingTilesMetadata(
      new Blob(['{"root":{},"asset":{"version":"1.0"}}']),
    );
    expect(metadata.status).toBe("underdeveloped");
    expect(metadata.diagnostics[0]!.severity).toBe("error");
  });
});
