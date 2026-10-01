import { describe, expect, it } from "vitest";
import { TerrainScatterBatch, TerrainScatterSource, ScatterWindSettings, makeScatterTransform, seededScatterTransforms, gridScatterTransforms, selectScatterLods, simplifyScatterMesh, autoScatterLodLevels } from "../../src-ts/terrain-scatter.js";
import { scatterRandom } from "../../src-ts/scatter-random.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import { readFileSync } from "node:fs";
const mesh = () => ({ positions: new Float32Array([-1,0,0,1,0,0,-1,10,0,1,10,0]), normals: new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]), indices: new Uint32Array([0,1,2,2,1,3]) });
describe("W09 native scatter contracts", () => {
  it("drops sub-floor LODs and rejects unordered ratios like the native TV13 chain",()=>{
    expect(autoScatterLodLevels(mesh(),{ratios:[1,.5],distances:[30],minTriangles:2})).toHaveLength(1);
    const levels=autoScatterLodLevels(mesh(),{ratios:[1,.5],distances:[30],minTriangles:1});expect(levels.map(l=>l.mesh.indices.length/3)).toEqual([2,1]);expect(levels[1]!.maxDistance).toBeUndefined();
    expect(()=>autoScatterLodLevels(mesh(),{ratios:[1,.5,.7]})).toThrow("descend");
  });
  it("applies masks, slope/elevation gates, edge margins and spatial minimum distances",()=>{
    const source=new TerrainScatterSource(new Float32Array([10,10,10,10]),2,2,{terrainWidth:20,origin:[-10,-10]});
    const population=seededScatterTransforms(source,{count:20,seed:42,minDistance:2,edgeMargin:2,filters:{minElevation:10,maxSlopeDegrees:0},mask:new Float32Array(4).fill(1)});
    for(let i=0;i<20;i++){
      const x=population[i*16+3]!,z=population[i*16+11]!;expect(x).toBeGreaterThanOrEqual(-8);expect(x).toBeLessThanOrEqual(8);expect(z).toBeGreaterThanOrEqual(-8);expect(z).toBeLessThanOrEqual(8);
      for(let j=0;j<i;j++)expect(Math.hypot(x-population[j*16+3]!,z-population[j*16+11]!)).toBeGreaterThanOrEqual(2-1e-5);
    }
    expect(()=>seededScatterTransforms(source,{count:1,filters:{minElevation:11},maxAttempts:4})).toThrow("accepted only");
    expect(()=>gridScatterTransforms(source,{spacing:5,densityScale:0})).toThrow("zero accepted");
  });
  it("matches independently executed bf8db93 transforms within 1e-5", () => {
    const golden=JSON.parse(readFileSync(new URL("../golden/w09/transforms.json",import.meta.url),"utf8"));
    const source=new TerrainScatterSource(new Float32Array(golden.heights),golden.width,golden.height,{terrainWidth:golden.terrainWidth,zScale:golden.zScale});
    const options={scale:[.8,1.4] as const,yawDegrees:[0,360] as const};
    for(const [actual,expected] of [[seededScatterTransforms(source,{...options,count:32,seed:42}),golden.random],[gridScatterTransforms(source,{...options,spacing:16,seed:123,jitter:.5}),golden.grid]] as const) {
      expect(actual.length).toBe(expected.length);
      expect(Math.max(...actual.map((x,i)=>Math.abs(x-expected[i])))).toBeLessThanOrEqual(1e-5);
    }
  });
  it("matches NumPy PCG64 draws rather than only repeating its own seed", () => {
    const random = scatterRandom(42);
    expect(Array.from({length:4}, () => random())).toEqual([0.7739560485559633,0.4388784397520523,0.8585979199113825,0.6973680290593639]);
    expect(() => scatterRandom(-1)).toThrow();
  });
  it("uses native row-major yaw, terrain height and cloned ownership", () => {
    const t=makeScatterTransform([3,4,5],90,2);
    expect([...t]).toEqual([expect.closeTo(0),0,2,3,0,2,0,4,-2,0,expect.closeTo(0),5,0,0,0,1]);
    const source=new TerrainScatterSource(new Float32Array([10,20,30,40]),2,2,{terrainWidth:10,zScale:2});
    expect(source.pixelToContract(.5,.5)).toEqual([5,30,5]);
    const a=seededScatterTransforms(source,{seed:42,count:5}), b=seededScatterTransforms(source,{seed:42,count:5});
    expect(a).toEqual(b); expect(a).not.toEqual(seededScatterTransforms(source,{seed:41,count:5}));
    expect(() => seededScatterTransforms(source,{count:1,mask:new Float32Array(4),maxAttempts:8})).toThrow("accepted only");
    expect(gridScatterTransforms(source,{spacing:5,seed:42,jitter:0}).length).toBe(64);
    const input=mesh(), batch=new TerrainScatterBatch({levels:[{mesh:input}],transforms:t});
    input.positions.fill(900); t.fill(0);
    expect(batch.snapshot().levels[0]!.mesh.positions[0]).toBe(-1);
    expect(batch.instanceBounds(0).min[1]).toBe(4);
  });
  it("contains rotated, scaled instances and maximum animated wind displacement", () => {
    const transforms=Float32Array.from([...makeScatterTransform([0,0,0],30,2),...makeScatterTransform([12,1,15],80,3)]);
    const batch=new TerrainScatterBatch({levels:[{mesh:mesh()}],transforms,wind:{enabled:true,amplitude:2,gustStrength:1},hlod:{distance:100,clusterRadius:30,simplifyRatio:1}});
    const s=batch.snapshot();
    for(let id=0;id<2;id++) { const b=batch.instanceBounds(id); for(let axis=0;axis<3;axis++) {expect(b.min[axis]).toBeGreaterThanOrEqual(s.bounds.min[axis]!); expect(b.max[axis]).toBeLessThanOrEqual(s.bounds.max[axis]!);} }
    expect(s.clusters[0]!.bounds).toEqual(s.bounds);
    expect(selectScatterLods([s],[0,0,250]).hlodCoveredInstances).toBe(2);
    expect(selectScatterLods([s],[0,0,20]).hlodClusterDraws).toBe(0);
    expect(batch.memoryReport().totalBufferBytes).toBeGreaterThan(transforms.byteLength);
  });
  it("rejects invalid wind even when disabled, invalid LODs and singular matrices", () => {
    for(const wind of [{speed:-1},{amplitude:NaN},{rigidity:2},{bendExtent:0},{gustFrequency:Infinity}]) expect(() => new ScatterWindSettings(wind)).toThrow();
    expect(() => new TerrainScatterBatch({levels:[{mesh:mesh()},{mesh:mesh()}],transforms:makeScatterTransform([0,0,0])})).toThrow();
    expect(() => new TerrainScatterBatch({levels:[{mesh:mesh()}],transforms:new Float32Array(16)})).toThrow();
  });
  it("QEM reduces indexed triangles deterministically and keeps valid data", () => {
    const input=mesh(), a=simplifyScatterMesh(input,.5), b=simplifyScatterMesh(input,.5);
    expect(a).toEqual(b); expect(a.indices.length).toBe(3);
    expect([...a.indices].every(i=>i<a.positions.length/3)).toBe(true);
  });
  it("scene snapshots and copies retain W09 data without borrowing source buffers", () => {
    const batch=new TerrainScatterBatch({levels:[{mesh:mesh()}],transforms:makeScatterTransform([0,0,0])});
    const scene=Forge3DScene.create(); scene.setScatterBatches([batch]); scene.setTimeSeconds(.37);
    expect(scene.copy().snapshot().scatter).toEqual(scene.snapshot().scatter);
    const s=scene.snapshot(); s.scatter![0]!.transforms.fill(0);
    expect(scene.snapshot().scatter![0]!.transforms[15]).toBe(1);
    scene.dispose(); expect(()=>scene.getScatterBatches()).toThrow();
  });
});
