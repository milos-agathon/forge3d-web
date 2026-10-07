import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { ProjKernel } from "../../src-ts/proj-kernel.js";
import {
  CrsTransformer,
  projAvailable,
  crsToEpsg,
  crsFromRasterMetadata,
  crsFromGeoJson,
} from "../../src-ts/crs.js";
import { TerrainDataset } from "../../src-ts/terrain-dataset.js";
import { PROJ_ASSETS } from "../../src-ts/proj-assets.js";
import { reprojectVectorLayer } from "../../src-ts/crs-layers.js";
import { reprojectGeoJson } from "../../src-ts/crs-geometry.js";
import { verifiedProjFactory, embedProjWorker } from '../../scripts/embed-proj-worker.mjs';
const read = (path: string) =>
  readFileSync(new URL("../../" + path, import.meta.url));
const fixture = JSON.parse(
  read("tests/fixtures/w14/crs-epsg-v1.json").toString(),
);
let kernel: ProjKernel;
beforeAll(async () => {
  verifiedProjFactory();
  const factory = createRequire(import.meta.url)(
    "../../assets/proj/proj-emscripten.js",
  ).default;
  const m = await factory({
    wasmBinary: read("assets/proj/proj-emscripten.wasm"),
    printErr: () => {},
  });
  kernel = new ProjKernel(m, read("assets/proj/proj.db"), {
    "us_noaa_conus.tif": read("assets/proj/us_noaa_conus.tif"),
  });
});
describe("W14 native CRS contract and W00 oracle", () => {
  it("preserves Unicode in regenerated fixture metadata and example text", () => {
    expect(fixture.projJson.area).toContain('6°E');
    expect(fixture.wkt.utm32).toContain('6°E');
    expect(read('tests/fixtures/w14/crs-epsg-v1.json').toString('utf8')).not.toMatch(/[ÂÃ]/u);
    expect(read('examples/w14-foundation.js').toString('utf8')).toContain('"Loading…"');
  });
  it("rejects injected top-level PROJ code before embedding or evaluation", () => {
    const bytes = read('assets/proj/proj-emscripten.js');
    const injected = Buffer.concat([Buffer.from('globalThis.__w14Injected = true;\n'), bytes]);
    expect(() => verifiedProjFactory(injected)).toThrow('W14 asset mismatch');
    const embedded = embedProjWorker('/* worker */\n');
    expect(embedded).toContain(verifiedProjFactory());
    expect(embedProjWorker(embedded)).toBe(embedded);
    expect(() => embedProjWorker(embedded.replace('var Module=moduleArg;', 'throw Error("executed");var Module=moduleArg;'))).toThrow('Previously embedded PROJ factory changed');
    expect((globalThis as any).__w14Injected).toBeUndefined();
  });
  it("pins every PROJ/database/grid asset to the dependency lock and exact digest", () => {
    for (const a of [...PROJ_ASSETS.assets, ...PROJ_ASSETS.grids])
      expect(
        createHash("sha256")
          .update(read("assets/proj/" + a.name))
          .digest("hex"),
      ).toBe(a.sha256);
    const lock = JSON.parse(
      readFileSync(
        new URL(
          "../../../../docs/parity/dependency-lock.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(PROJ_ASSETS.tarballSha256).toBe(
      lock.assets.find((a: any) => a.id === "proj-wasm").source.sha256,
    );
    const provenance = JSON.parse(read("tests/fixtures/w14/provenance.json").toString());
    const bytes = read("tests/fixtures/w14/crs-epsg-v1.json");
    expect(bytes.includes(13)).toBe(false);
    expect(provenance.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const contract = JSON.parse(read("tests/parity/fixture-contracts.json").toString()).fixtures.find((f:any)=>f.id==="crs-epsg-v1");
    expect(contract.generator.parameters).toEqual({geographicCrs:"EPSG:4326",projectedCrs:["EPSG:3857","EPSG:32632"],pointCount:32,includesAxisOrderCases:true});
    expect(contract).toEqual(JSON.parse(read("tests/fixtures/w14/w00-crs-contract.json").toString()));
  });
  it("aligns north-up and rotated raster origins, preserving elevation and caller data", async()=>{
    const transformer:any={maxPoints:100,async transformCoords(points:number[][],source:string,target:string){
      const values=kernel.transform(new Float64Array(points.flat()),source,target,true,2);
      return points.map((_,i)=>[values[2*i],values[2*i+1]]);
    }};
    const t=fixture.terrain;
    const input:any={name:"map",crs:"EPSG:4326",features:t.points.map((p:number[],i:number)=>({id:i+1,kind:"point",position:[p[0],7,p[1]]}))};
    const original=structuredClone(input);
    const output=await reprojectVectorLayer(transformer,input,t);
    expect(output.crs).toBeUndefined();expect(input).toEqual(original);
    output.features.forEach((f:any,i:number)=>{
      expect(f.position[0]).toBeCloseTo(t.world[i][0],6);
      expect(f.position[2]).toBeCloseTo(t.world[i][1],6);expect(f.position[1]).toBe(7);
    });
    const rotated:any={crs:"EPSG:3857",width:3,height:5,spacing:[2,3],transform:[500,2,1,100,1,-3]};
    const corner:any={name:"rotated",crs:"EPSG:3857",features:[{id:9,kind:"point",position:[501.5,7,99]}]};
    expect((await reprojectVectorLayer(transformer,corner,rotated)).features[0]).toMatchObject({position:[-2,7,-6]});
    await expect(reprojectVectorLayer(transformer,corner,{...rotated,transform:[0,1,1,0,1,1]})).rejects.toMatchObject({code:"INVALID_INPUT"});
    await expect(reprojectVectorLayer(transformer,{...corner,features:[]},{...rotated,transform:undefined})).rejects.toMatchObject({code:"INVALID_INPUT"});
  });
  it("uses the pinned grid in an ordinary system-to-system conversion", () => {
    const c=fixture.grid.crsControl;
    const output=kernel.transform(new Float64Array(c.points.flat()),c.source,c.target,true,2);
    output.forEach((n,i)=>expect(Math.abs(n-c.expected.flat()[i])).toBeLessThanOrEqual(1e-7));
    expect(Math.abs(output[0]!-c.points[0][0])).toBeGreaterThan(1e-5);
  });
  it.each(fixture.published.cases)("matches published EPSG controls: $source to $target", (c:any)=>{
    const output=kernel.transform(new Float64Array(c.points.flat()),c.source,c.target,true,2);
    output.forEach((n,i)=>expect(Math.abs(n-c.expected.flat()[i])).toBeLessThanOrEqual(c.target==="EPSG:4277" ? 1e-7 : .01));
  });
  it.each(fixture.cases)(
    "matches independent projected and geographic controls: $target",
    (control: any) => {
      const points = new Float64Array(control.points.flat());
      const projected = kernel.transform(
        points,
        control.source,
        control.target,
        true,
        2,
      );
      projected.forEach((n, i) =>
        expect(Math.abs(n - control.expected.flat()[i])).toBeLessThanOrEqual(
          control.target === "EPSG:4326" ? 1e-7 : 0.01,
        ),
      );
      const roundtrip = kernel.transform(
        projected,
        control.target,
        control.source,
        true,
        2,
      );
      roundtrip.forEach((n, i) =>
        expect(Math.abs(n - points[i]!)).toBeLessThanOrEqual(control.source === "EPSG:4326" ? 1e-7 : 0.01),
      );
      const back = kernel.transform(
        roundtrip,
        control.source,
        control.target,
        true,
        2,
      );
      back.forEach((n, i) =>
        expect(Math.abs(n - projected[i]!)).toBeLessThanOrEqual(0.02),
      );
    },
  );
  it("honors authority axis order and visualization XY order", () => {
    const xy = kernel.transform(
      new Float64Array([9, 40]),
      "EPSG:4326",
      "EPSG:32632",
      true,
      2,
    );
    const authority = kernel.transform(
      new Float64Array([40, 9]),
      "EPSG:4326",
      "EPSG:32632",
      false,
      2,
    );
    expect(authority).toEqual(xy);
    expect(kernel.metadata("EPSG:4326").axes.map((a) => a.direction)).toEqual([
      "north",
      "east",
    ]);
  });
  it("identifies EPSG, WKT2, WKT1 without root authority and PROJ CRS", () => {
    expect(kernel.metadata("epsg:4326").epsg).toBe(4326);
    expect(kernel.metadata(fixture.wkt.utm32).epsg).toBe(32632);
    expect(kernel.metadata(JSON.stringify(fixture.projJson)).epsg).toBe(32632);
    const noId = fixture.wkt.utm32NoId.replace(
      /,AUTHORITY\["EPSG","32632"\]\]$/,
      "]",
    );
    expect(kernel.metadata(noId).epsg).toBe(32632);
    expect(
      kernel.metadata("+proj=utm +zone=32 +datum=WGS84").axes[0]?.unitName,
    ).toBe("metre");
    expect(() => kernel.metadata("EPSG:99999999")).toThrow();
    expect(() => kernel.metadata('GEOGCRS["broken"]')).toThrow();
    expect(() => kernel.metadata("+proj=pipeline +step +proj=noop")).toThrow();
  });
  it("supports empty arrays, copied identity, XYZ/T and 10000 points", () => {
    const points = new Float64Array([9, 40, 123, 2026]);
    const same = kernel.transform(points, "EPSG:4326", "EPSG:4326", true, 4);
    expect(same).toEqual(points);
    expect(same).not.toBe(points);
    expect(
      kernel.transform(new Float64Array(), "EPSG:4326", "EPSG:32632", true, 2),
    ).toHaveLength(0);
    const many = new Float64Array(
      Array.from({ length: 10000 }, (_, i) => [
        138 + (i % 100) / 100,
        35 + Math.floor(i / 100) / 100,
      ]).flat(),
    );
    const result = kernel.transform(many, "EPSG:4326", "EPSG:32654", true, 2);
    expect(result.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < 10000; i++) {
      expect(result[i * 2]).toBeGreaterThan(200000);
      expect(result[i * 2 + 1]).toBeGreaterThan(3800000);
    }
  });
  it("uses the real bundled grid and rejects missing best grids structurally", () => {
    const shifted = kernel.transform(
      new Float64Array(fixture.grid.points.flat()),
      "",
      "",
      true,
      2,
      fixture.grid.pipeline,
    );
    shifted.forEach((value, i) =>
      expect(
        Math.abs(value - fixture.grid.expected.flat()[i]),
      ).toBeLessThanOrEqual(1e-7),
    );
    expect(fixture.grid.sha256).toBe(PROJ_ASSETS.grids[0].sha256);
    try {
      kernel.transform(
        new Float64Array([-100, 40]),
        "EPSG:4267",
        "EPSG:4269",
        true,
        2,
      );
      throw Error("silent fallback");
    } catch (error: any) {
      expect(error.code).toBe("UNSUPPORTED_FEATURE");
      expect(error.details.kind).toBe("crs-missing-grid");
      expect(error.details.grids).toContain(
        "us_noaa_nadcon5_nad27_nad83_1986_conus.tif",
      );
    }
    expect(() =>
      kernel.transform(
        new Float64Array([9, 100]),
        "EPSG:4326",
        "EPSG:32632",
        true,
        2,
      ),
    ).toThrow();
  });
  it("does not leak native allocations on repeated success and failure", () => {
    const heap = kernel.module.HEAPU8.byteLength;
    for (let i = 0; i < 60; i++) {
      kernel.metadata("EPSG:32632");
      kernel.transform(
        new Float64Array([9, 40]),
        "EPSG:4326",
        "EPSG:32632",
        true,
        2,
      );
      try {
        kernel.metadata("EPSG:99999999");
      } catch {}
    }
    expect(kernel.module.HEAPU8.byteLength).toBe(heap);
  });
  it("extracts raster/vector metadata without inventing a projected CRS", () => {
    expect(crsToEpsg("epsg:32654")).toBe(32654);
    expect(crsToEpsg("EPSG:invalid")).toBeNull();
    expect(crsToEpsg("EPSG:4326")).toBe(4326);
    expect(crsToEpsg("WGS84")).toBe(4326);
    expect(crsToEpsg("urn:ogc:def:crs:EPSG::4326")).toBe(4326);
    expect(
      crsFromRasterMetadata({ geoKeys: { ProjectedCSTypeGeoKey: 32632 } }),
    ).toBe("EPSG:32632");
    expect(
      crsFromRasterMetadata({ geoKeys: { ProjectedCSTypeGeoKey: 32767 } }),
    ).toBeNull();
    expect(crsFromGeoJson({ type: "FeatureCollection", features: [] })).toBe(
      "EPSG:4326",
    );
  });
  it("retains the native terrain CRS default and explicit state", () => {
    const input = {
      width: 2,
      height: 2,
      heights: new Float32Array([0, 1, 2, 3]),
    };
    expect(TerrainDataset.fromArray(input).crs).toBeUndefined();
    for (const crs of ["EPSG:4326", "EPSG:32654"])
      expect(TerrainDataset.fromArray({ ...input, crs }).crs).toBe(crs);
  });
  it("retains the native Fuji multipoint ordering and range", () => {
    const points = new Float64Array(
      [
        [138.7, 35.35],
        [138.72, 35.36],
        [138.74, 35.37],
        [138.76, 35.38],
      ].flat(),
    );
    const result = kernel.transform(points, "EPSG:4326", "EPSG:32654", true, 2);
    for (let i = 0; i < 4; i++) {
      expect(result[i * 2]).toBeGreaterThan(250000);
      expect(result[i * 2]).toBeLessThan(500000);
      if (i)
        expect(result[i * 2 + 1]).toBeGreaterThan(result[(i - 1) * 2 + 1]!);
    }
    expect(
      Math.max(result[0]!, result[2]!, result[4]!, result[6]!) -
        Math.min(result[0]!, result[2]!, result[4]!, result[6]!),
    ).toBeLessThan(10000);
  });
  it("reports unavailable worker backends and never returns a silent identity", async () => {
    vi.stubGlobal("Worker", undefined);
    try {
      expect(typeof projAvailable()).toBe("boolean");
      expect(projAvailable()).toBe(false);
      await expect(
        CrsTransformer.create({ cache: null }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_FEATURE",
        details: { kind: "crs-backend-unavailable" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("recomputes bounds for large geometry without argument-spread limits", async () => {
    const transformer: any = {
      maxPoints: 200000,
      transformCoords: async (points: number[][]) =>
        points.map((p) => [p[0]! + 1, p[1]! + 2]),
    };
    const points = Array.from({ length: 150001 }, (_, i) => [i, 40]);
    const input = {
      type: "MultiPoint",
      coordinates: points,
      bbox: [0, 40, 150000, 40],
    };
    const output = await reprojectGeoJson(
      transformer,
      input,
      "source",
      "target",
      {},
    );
    expect(output.bbox).toEqual([1, 42, 150001, 42]);
    expect(input.bbox).toEqual([0, 40, 150000, 40]);
  });
  it("bounds cyclic or excessively nested geometry topology with typed errors", async () => {
    const cyclic: any = { type: "GeometryCollection", geometries: [] };
    cyclic.geometries.push(cyclic);
    await expect(
      reprojectGeoJson(
        { maxPoints: 10000 } as any,
        cyclic,
        "source",
        "target",
        {},
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
    await expect(
      reprojectGeoJson(
        { maxPoints: 1 } as any,
        { type: "Point", coordinates: [1, "2"] },
        "source",
        "target",
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
