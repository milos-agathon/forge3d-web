import { describe, expect, it } from "vitest";
import { TerrainScatterBatch, TerrainScatterSource, ScatterWindSettings, makeScatterTransform, seededScatterTransforms, gridScatterTransforms, selectScatterLods, simplifyScatterMesh, autoScatterLodLevels } from "../../src-ts/terrain-scatter.js";
import { scatterRandom } from "../../src-ts/scatter-random.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import { readFileSync } from "node:fs";
const mesh = () => ({ positions: new Float32Array([-1,0,0,1,0,0,-1,10,0,1,10,0]), normals: new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]), indices: new Uint32Array([0,1,2,2,1,3]) });
describe("W09 native scatter contracts", () => {
  it("matches historical native 3D clusters, baked geometry and activation",()=>{
    const g=JSON.parse(readFileSync(new URL("../golden/w09/scatter-runtime.json",import.meta.url),"utf8"));
    const b=new TerrainScatterBatch({levels:[{mesh:mesh()}],transforms:new Float32Array(g.transforms),maxDrawDistance:100,hlod:{distance:40,clusterRadius:16,simplifyRatio:1}}),snapshot=b.snapshot();
    expect(snapshot.clusters).toHaveLength(g.clusters.length);
    for(let i=0;i<g.clusters.length;i++){const actual=snapshot.clusters[i]!,truth=g.clusters[i];expect(actual.instanceIndices).toEqual(truth.ids);expect([...actual.mesh.indices]).toEqual(truth.indices);
      for(const [values,wanted] of [[actual.center,truth.center],[actual.mesh.positions,truth.positions],[actual.mesh.normals,truth.normals]] as const)expect(Math.max(...Array.from(values,(v,j)=>Math.abs(v-wanted[j])))).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(actual.radius-truth.radius)).toBeLessThanOrEqual(1e-5);
    }
    g.eyes.forEach((eye:[number,number,number],i:number)=>expect(selectScatterLods([snapshot],eye).hlodClusterDraws).toBe(g.activeClusters[i].length));
    const single=new TerrainScatterBatch({levels:[{mesh:mesh(),maxDistance:10},{mesh:mesh(),maxDistance:25},{mesh:mesh()}],transforms:makeScatterTransform([0,0,0])}).snapshot();
    g.lodDistances.forEach((distance:number,i:number)=>expect(selectScatterLods([single],[0,0,distance]).lodInstanceCounts).toEqual([0,1,2].map(level=>+(level===g.lodIndices[i]))));
  });

  it("matches directly executed historical native QEM positions, indices and normals",()=>{
    const g=JSON.parse(readFileSync(new URL("../golden/w09/qem.json",import.meta.url),"utf8"));
    const positions:number[]=[],indices:number[]=[],{width,height}=g.input;
    for(let z=0;z<height;z++)for(let x=0;x<width;x++)positions.push(x/3,((x*x*3+z*7+x*z*5)%17)/11,z/4);
    for(let z=0;z<height-1;z++)for(let x=0;x<width-1;x++){const a=z*width+x,b=a+1,c=a+width,d=c+1;indices.push(a,c,b,b,c,d);}
    const input={positions:new Float32Array(positions),normals:new Float32Array(positions.length),indices:new Uint32Array(indices)};
    for(const c of g.results){const a=simplifyScatterMesh(input,c.ratio);expect([...a.indices]).toEqual(c.indices);expect(a.positions.length).toBe(c.positions.length);expect(Math.max(...a.positions.map((v,i)=>Math.abs(v-c.positions[i])))).toBeLessThanOrEqual(1e-5);expect(Math.max(...a.normals.map((v,i)=>Math.abs(v-c.normals[i])))).toBeLessThanOrEqual(1e-5);}
  });

  it("matches native filtered and masked placement including rectangular resampling",()=>{
    const g=JSON.parse(readFileSync(new URL("../golden/w09/transforms.json",import.meta.url),"utf8"));
    const source=new TerrainScatterSource(new Float32Array(g.heights),g.width,g.height,{terrainWidth:g.terrainWidth,zScale:g.zScale});
    for(const c of g.cases){
      const options={seed:c.name==="mask-resampled-filter"?42:c.mode==="random"?42:123,scale:[.8,1.4] as const,yawDegrees:[0,360] as const,edgeMargin:c.name==="mask-resampled-filter"?4:10,
        ...(c.name.includes("filter")?{filters:{minElevation:1,maxElevation:5,...(c.name!=="mask-resampled-filter"?{maxSlopeDegrees:15}:{})}}:{}),
        ...(c.mode==="mask"?{mask:{data:new Float32Array(c.mask),width:c.maskWidth,height:c.maskHeight}}:{})};
      const actual=c.mode==="random"?seededScatterTransforms(source,{...options,count:24}):gridScatterTransforms(source,{...options,spacing:8,jitter:.5});
      expect(actual.length,c.name).toBe(c.transforms.length);
      expect(Math.max(...actual.map((v,i)=>Math.abs(v-c.transforms[i]))),c.name).toBeLessThanOrEqual(1e-5);
    }
  });
  it("keeps native singleton and vertically separated cells as individual draws",()=>{
    for(const transforms of [makeScatterTransform([1,1,1]),Float32Array.from([...makeScatterTransform([1,1,1]),...makeScatterTransform([1,40,1])])]){
      const b=new TerrainScatterBatch({levels:[{mesh:mesh()}],transforms,hlod:{distance:10,clusterRadius:30,simplifyRatio:1}});
      expect(b.snapshot().clusters).toHaveLength(0);
      expect(selectScatterLods([b.snapshot()],[0,0,100]).hlodCoveredInstances).toBe(0);
    }
  });
  it("simplifies a dense native HLOD cell beyond the removed 4096-triangle cap",()=>{
    const input=mesh();
    const denseMesh={positions:input.positions,normals:input.normals,indices:Uint32Array.from([...input.indices,...input.indices,...input.indices,...input.indices])};
    const transforms=new Float32Array(600*16);
    for(let i=0;i<600;i++)transforms.set(makeScatterTransform([1+i%20,0,1+Math.floor(i/20)]),i*16);
    const b=new TerrainScatterBatch({levels:[{mesh:denseMesh}],transforms,hlod:{distance:100,clusterRadius:64,simplifyRatio:.5}});
    expect(b.snapshot().clusters).toHaveLength(1);
    expect(b.snapshot().clusters[0]!.mesh.indices.length).toBeLessThan(denseMesh.indices.length*600);
  });

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
