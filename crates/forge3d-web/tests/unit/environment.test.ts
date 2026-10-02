import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  Forge3DEnvironment,
  normalizeEnvironment,
  sunPosition,
  environmentMemoryReport,
} from "../../src-ts/environment.js";
import { Forge3DScene } from "../../src-ts/scene.js";
const truth = JSON.parse(
  readFileSync(new URL("../golden/w10/sun.json", import.meta.url), "utf8"),
);
describe("W10 native UTC ephemeris and owned configuration", () => {
  it("matches 48 independently executed native sun vectors", () => {
    for (const c of truth.cases) {
      const s = sunPosition(c.latitude, c.longitude, c.utc);
      expect(Math.abs(s.azimuth-c.azimuth)).toBeLessThanOrEqual(truth.tolerances.angularDegrees);
      expect(Math.abs(s.elevation-c.elevation)).toBeLessThanOrEqual(truth.tolerances.angularDegrees);
      s.direction.forEach((v, i) =>
        expect(Math.abs(v - c.direction[i])).toBeLessThanOrEqual(truth.tolerances.directionAbs),
      );
    }
  });
  it("rejects invalid UTC calendar dates and timezone-local input", () => {
    for (const utc of [
      "2024-02-30T12:00:00Z",
      "2024-06-21",
      "bad",
      "2024-06-21T12:00:00+02:00",
    ])
      expect(() => sunPosition(45, 0, utc)).toThrow();
    expect(sunPosition(45, 0, "2024-06-21T12:00:00")).toEqual(
      sunPosition(45, 0, "2024-06-21T12:00:00Z"),
    );
  });
  it("synchronizes scene sun and UTC animation after copy", () => {
    const scene = Forge3DScene.create();
    const e = new Forge3DEnvironment({
      sun: {
        latitude: 51.5,
        longitude: 0,
        utc: "2024-06-21T06:00:00Z",
        timeScale: 3600,
      },
      sky: {},
    });
    scene.setEnvironment(e);
    const a = scene.snapshot();
    scene.setTimeSeconds(6);
    const b = scene.snapshot();
    expect(b.environment!.sunDirection).toEqual(e.snapshot(6).sunDirection);
    expect(b.environment!.sunDirection).not.toEqual(
      a.environment!.sunDirection,
    );
    const light = b.lighting.lights.find((l) => l.type === "directional")!;
    if (light.type === "directional")
      expect(light.direction).toEqual(
        b.environment!.sunDirection.map((v) => -v),
      );
    expect(scene.copy().snapshot()).toEqual(b);
    scene.dispose();
  });
  it("copies masks and voxels before caller mutation", () => {
    const data = new Float32Array([0.7]),
      mask = new Float32Array([0.8]);
    const e = new Forge3DEnvironment({
      volumes: [{ bounds: [0, 0, 0, 1, 1, 1], data }],
      water: [{ bounds: [0, 0, 1, 1], mask }],
    });
    data[0] = 0;
    mask[0] = 0;
    const snapshot = e.snapshot();
    expect(snapshot.volumes[0]!.data[0]).toBeCloseTo(0.7);
    expect(snapshot.water[0]!.mask[0]).toBeCloseTo(0.8);
    snapshot.water[0]!.mask[0] = 0;
    expect(e.snapshot().water[0]!.mask[0]).toBeCloseTo(0.8);
  });
  it("rejects empty bounds, mismatched volumes, masks and invalid wind", () => {
    for (const input of [
      { volumes: [{ bounds: [0, 0, 0, 0, 1, 1] }] },
      {
        volumes: [
          { bounds: [0, 0, 0, 1, 1, 1], dimensions: [2, 2, 2], data: [1] },
        ],
      },
      { water: [{ bounds: [0, 0, 1, 1], mask: [NaN] }] },
      { clouds: { wind: [Infinity, 0] } },
      { clouds: { seed: 1.5 } },
      { resolutionScale: 0.7 },
      { steps: 9.5 },
      { fog: { anisotropy: 1.001 } },
    ])
      expect(() => normalizeEnvironment(input as any)).toThrow();
  });
  it("accounts ceil half resolution and all planar layers", () => {
    const half = normalizeEnvironment({
      resolutionScale: 0.5,
      water: [{ bounds: [0, 0, 1, 1], reflection: "planar" }],
    });
    const full = { ...half, resolutionScale: 1 as const };
    const a = environmentMemoryReport(half, 193, 129),
      b = environmentMemoryReport(full, 193, 129);
    expect(a.effectWidth).toBe(97);
    expect(a.effectHeight).toBe(65);
    expect(b.gpuBytes - a.gpuBytes).toBe((193 * 129 - 97 * 65) * 20);
  });
  it("has exact static cloud seed and wind configuration after serialization", () => {
    const e = new Forge3DEnvironment({
      clouds: { preset: "static", seed: 123 },
    });
    const s = e.snapshot();
    expect(s.clouds!.wind).toEqual([0, 0]);
    expect(normalizeEnvironment(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

it("uses native sky/fog defaults and accepts HG endpoints without NaN inputs",()=>{
  const s=normalizeEnvironment({sky:{},fog:{},clouds:{preset:"gentle"}});
  expect(s.sky).toMatchObject({sunSize:1,groundAlbedo:0.3,sunIntensity:1,aerialPerspective:true,aerialDensity:1});
  expect(s.fog).toMatchObject({mode:"uniform",anisotropy:0,godRays:false,falloff:0.1,shaftIntensity:1,shaftSamples:32,useShadows:true});
  expect(s.clouds!.animationSpeed).toBe(0.3);
  for(const anisotropy of [-1,1])expect(normalizeEnvironment({fog:{anisotropy}}).fog!.anisotropy).toBe(anisotropy);
});

it("rejects invalid new native controls at the authoring boundary",()=>{
  for(const input of [{sky:{aerialDensity:-1}},{sky:{aerialPerspective:1}},{fog:{shaftSamples:9.5}},{fog:{useShadows:1}},{fog:{shaftIntensity:11}},{clouds:{animationSpeed:NaN}},{water:[{bounds:[0,0,1,1],fresnelPower:0}]},{water:[{bounds:[0,0,1,1],mode:"unknown"}]}])expect(()=>normalizeEnvironment(input as any)).toThrow();
});
import { generateDensityVolume } from "../../src-ts/density-volume.js";
const densities = JSON.parse(
  readFileSync(new URL("../golden/w10/density.json", import.meta.url), "utf8"),
);
describe("W10 TV6 density presets", () => {
  it("matches six independently executed native fields including ground locking", async () => {
    for (const c of densities.cases) {
      const result = await generateDensityVolume({
        preset: c.preset,
        bounds: [1, 0, 1, 7, 4, 7],
        dimensions: [8, 6, 8],
        edgeSoftness: 0.25,
        noiseStrength: 0.3,
        ceiling: 0.4,
        plumeSpread: 0.35,
        wind: [0.2, 1, 0.1],
        seed: 13,
        terrain: {
          heights: new Float32Array(64).fill(c.terrainHeight),
          width: 8,
          height: 8,
          bounds: [0, 0, 8, 8],
        },
      });
      const data = Array.from(result.data!);
      expect(Math.max(...data)).toBeGreaterThan(0.001);
      data.forEach((v, i) =>
        expect(Math.abs(v - c.data[i])).toBeLessThan(1e-7),
      );
    }
  });
  it("cancels before returning partial density data and reports slice progress", async () => {
    const abort = new AbortController();
    let count = 0;
    await expect(
      generateDensityVolume(
        { preset: "plume", bounds: [0, 0, 0, 8, 8, 8] },
        {
          signal: abort.signal,
          onProgress: () => {
            count++;
            abort.abort();
          },
        },
      ),
    ).rejects.toThrow();
    expect(count).toBe(1);
  });
  it("rejects invalid native preset shapes before generation", async () => {
    await expect(
      generateDensityVolume({
        preset: "plume",
        bounds: [0, 0, 0, 1, 1, 1],
        dimensions: [1, 2, 2],
      }),
    ).rejects.toThrow();
  });
});
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
it("locks reference fixtures to actual native git source bytes", () => {
  for (const name of [
    "sky",
    "clouds",
    "volumetric",
    "water_surface",
    "sun",
    "density",
  ]) {
    const fixture = JSON.parse(
      readFileSync(
        new URL(`../golden/w10/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    const p = fixture.provenance ?? fixture;
    const bytes = execFileSync("git", ["show", `${p.commit}:${p.path}`]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(p.sha256);
    if (fixture.source) expect(fixture.source).toBe(bytes.toString());
  }
});
it("reconstructs UTC animation from a serialized environment clock", () => {
  const e = new Forge3DEnvironment({
    sun: {
      latitude: 51.5,
      longitude: 0,
      utc: "2024-06-21T06:00:00Z",
      timeScale: 3600,
    },
  });
  const copy = new Forge3DEnvironment(JSON.parse(JSON.stringify(e.snapshot())));
  expect(copy.snapshot(6).sunDirection).toEqual(e.snapshot(6).sunDirection);
});

it("raw JavaScript shape errors are rejected before normalization", () => {
  for (const input of [
    null,
    1,
    [],
    { sky: 3 },
    { clouds: [] },
    { volumes: {} },
    { water: {} },
    { water: [{ bounds: null }] },
  ])
    expect(() => normalizeEnvironment(input as any)).toThrow();
});

it("locks installed-native scene references and historical PNG provenance", () => {
  const root = new URL("../golden/w10/native/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  expect(manifest.tolerances.ssimMin).toBe(0.98);
  for (const variant of manifest.variants) {
    expect(createHash("sha256").update(readFileSync(new URL(`${variant.id}.rgba`, root))).digest("hex")).toBe(variant.sha256);
    if (variant.reflectionControl) {
      const control=readFileSync(new URL(`${variant.id}-disabled.rgba`,root));
      expect(createHash("sha256").update(control).digest("hex")).toBe(variant.reflectionControl.sha256);
      const image=readFileSync(new URL(`${variant.id}.rgba`,root));
      const delta=image.reduce((sum,byte,i)=>sum+Math.abs(byte-control[i]!),0)/image.length;
      expect(delta).toBe(variant.reflectionControl.meanByteDifference);
      expect(delta).toBeGreaterThan(.5);
    }
    if (variant.historical) {
      const h = variant.historical;
      const source = execFileSync("git", ["show", `${h.commit}:${h.path}`]);
      expect(createHash("sha256").update(source).digest("hex")).toBe(h.sha256);
      expect(readFileSync(new URL(`${variant.id}-historical.png`, root))).toEqual(source);
    }
  }
});

it("uses W00 volume bounds and reserves W11 convergence tolerances",()=>{
  const c=JSON.parse(readFileSync(new URL("../golden/w10/volume-temporal-v1.json",import.meta.url),"utf8"));
  const w00=JSON.parse(readFileSync(new URL("../parity/fixture-contracts.json",import.meta.url),"utf8"));
  const fixture=(Array.isArray(w00)?w00:w00.fixtures).find((f:any)=>f.id===c.fixture);
  expect(c.bounds).toEqual(fixture.generator.parameters.boundedVolume);
  expect(c.minimumContributingPixels).toBeGreaterThanOrEqual(100000);
  expect(c.scope).toContain("W11");
});
it("validates owned masked-terrain and foam controls",()=>{
  const water={bounds:[-1,-1,1,1] as [number,number,number,number],terrainMask:true,reflection:"planar" as const,foamNoiseScale:32};
  const e=new Forge3DEnvironment({water:[water]});
  expect(e.copy().snapshot().water[0]).toMatchObject({terrainMask:true,foamNoiseScale:32});
  expect(()=>new Forge3DEnvironment({water:[water,water]})).toThrow();
  for(const foamNoiseScale of [0,NaN,Infinity])expect(()=>new Forge3DEnvironment({water:[{...water,foamNoiseScale}]})).toThrow();
  expect(environmentMemoryReport(e.snapshot(),192,128).gpuBytes-environmentMemoryReport(new Forge3DEnvironment({water:[{...water,terrainMask:false}]}).snapshot(),192,128).gpuBytes).toBe(96);
});
it("pins W09 hashes only for the explicitly selected, matching profile", async()=>{
  const {checkPreservationProfile}=await import("../browser/w10-preservation-profile.mjs");
  const c=JSON.parse(readFileSync(new URL("../golden/w10/w09-preservation.json",import.meta.url),"utf8"));
  const observed={platform:c.profile.platform,browser:c.profile.browser,adapter:{...c.profile.adapter}};
  expect(checkPreservationProfile(c,undefined,{platform:"linux",browser:"different",adapter:{vendor:"google"}})).toBe(false);
  expect(checkPreservationProfile(c,c.profile.id,observed)).toBe(true);
  expect(()=>checkPreservationProfile(c,"unknown",observed)).toThrow();
  expect(()=>checkPreservationProfile(c,c.profile.id,{...observed,platform:"linux"})).toThrow();
  expect(()=>checkPreservationProfile(c,c.profile.id,{...observed,browser:"different"})).toThrow();
  expect(()=>checkPreservationProfile(c,c.profile.id,{...observed,adapter:{...observed.adapter,architecture:"swiftshader"}})).toThrow();
});

it("matches native water mode, shore, distortion and foam-noise defaults",()=>{
 expect(normalizeEnvironment({water:[{bounds:[0,0,1,1]}]}).water[0]).toMatchObject({mode:"transparent",shoreAttenuationWidth:0.3,waveDistortionStrength:0.02,foamNoiseScale:20,terrainMask:false});
 expect(()=>normalizeEnvironment({water:[{bounds:[0,0,1,1],terrainMask:1}]} as any)).toThrow();
});
