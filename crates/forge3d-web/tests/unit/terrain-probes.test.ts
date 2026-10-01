import { describe, it, expect } from "vitest";
import { TerrainLightingProbes, packTerrainProbes, normalizeProbeGrid, probeCubeDirection, probeShBasis, type TerrainProbeSnapshot } from "../../src-ts/terrain-probes.js";
import { TerrainScatterSource } from "../../src-ts/scatter-source.js";

function fixture(): TerrainProbeSnapshot {
 return {grid:{origin:[0,0],spacing:[10,10],dims:[1,1],heightOffset:5,edgeBlend:[10,10]},positions:new Float32Array([0,5,0]),coefficients:Float32Array.from({length:27},(_,i)=>i/27),reflectionResolution:2,reflectionMips:[new Float32Array(96).fill(.5),new Float32Array(24).fill(.25)],strength:1,reflectionStrength:1,debug:"none"};
}
describe("W09 probe ownership and storage contract",()=>{
 it("admits native separate 4096 irradiance and 256 reflection probe limits",()=>{
  expect(normalizeProbeGrid({origin:[0,0],spacing:[1,1],dims:[4096,1]}).dims).toEqual([4096,1]);
  expect(()=>normalizeProbeGrid({origin:[0,0],spacing:[1,1],dims:[4097,1]})).toThrow();
  const s=fixture();s.grid={...s.grid,dims:[4096,1]};s.positions=new Float32Array(4096*3);s.coefficients=new Float32Array(4096*27);
  s.reflectionGrid={origin:[0,0],spacing:[1,1],dims:[256,1],heightOffset:5,edgeBlend:[1,1]};s.reflectionPositions=new Float32Array(256*3);s.reflectionMips=[new Float32Array(256*96),new Float32Array(256*24)];
  const report=new TerrainLightingProbes(s).memoryReport();expect(report.irradianceProbeCount).toBe(4096);expect(report.reflectionProbeCount).toBe(256);
  const packed=packTerrainProbes(s);expect([...packed.subarray(12,16)]).toEqual([4096,0,256,2]);expect([...packed.subarray(24,28)]).toEqual([8,40968,41224,0]);
  s.reflectionGrid={...s.reflectionGrid,dims:[257,1]};expect(()=>new TerrainLightingProbes(s)).toThrow();
 });
 it("requires both explicit reflection placement fields and validates their ownership",()=>{
  const s=fixture();s.reflectionGrid={...s.grid};expect(()=>new TerrainLightingProbes(s)).toThrow();s.reflectionPositions=new Float32Array([1,2,3]);
  const p=new TerrainLightingProbes(s);s.reflectionPositions.fill(99);expect([...p.snapshot().reflectionPositions!]).toEqual([1,2,3]);
 });

 it("packs vec4-aligned coefficients and mip-major cubemaps without aliasing",()=>{
  const v=fixture(),p=new TerrainLightingProbes(v);v.coefficients.fill(99);
  const snapshot=p.snapshot(),packed=packTerrainProbes(snapshot);
  expect([...packed.subarray(32,36)]).toEqual([0,5,0,0]);
  for(let k=0;k<9;k++)expect([...packed.subarray(36+k*4,40+k*4)]).toEqual([...snapshot.coefficients.subarray(k*3,k*3+3),0]);
  expect([...packed.subarray(76)]).toEqual([...snapshot.reflectionMips[0]!,...snapshot.reflectionMips[1]!]);
  expect(p.memoryReport()).toEqual({probeCount:1,irradianceProbeCount:1,reflectionProbeCount:1,coefficientBytes:108,positionBytes:12,irradiancePositionBytes:12,reflectionPositionBytes:12,reflectionBytes:480,gpuBytes:784});
  snapshot.positions.fill(0);expect(p.snapshot().positions[1]).toBe(5);
  p.dispose();expect(()=>p.snapshot()).toThrow("disposed");
 });
 it("rejects malformed dimensions, nonfinite payloads and illegal strengths",()=>{
  for(const edit of [(s:TerrainProbeSnapshot)=>s.coefficients=new Float32Array(26),(s:TerrainProbeSnapshot)=>s.positions[0]=NaN,(s:TerrainProbeSnapshot)=>s.reflectionMips.pop(),(s:TerrainProbeSnapshot)=>s.strength=2,(s:TerrainProbeSnapshot)=>s.grid.edgeBlend=[1] as any]){const v=fixture();edit(v);expect(()=>new TerrainLightingProbes(v)).toThrow();}
 });
 it("uses y-up public cube directions and native z-up SH basis",()=>{
  expect(probeCubeDirection(4,0,0).map(v=>v+0)).toEqual([0,1,0]);
  expect(probeShBasis([0,1,0])[2]).toBe(.488603);
  expect(probeShBasis([0,1,0])[6]).toBe(.630784);
 });
 it("rejects workload and output budgets, and cancellation before loading WASM",async()=>{
  const source=new TerrainScatterSource(new Float32Array(4),2,2,{terrainWidth:10}),grid={origin:[5,5],spacing:[5,5],dims:[1,1]} as const;
  await expect(TerrainLightingProbes.bake(source,{grid,reflectionResolution:64,memoryBudgetBytes:1024})).rejects.toMatchObject({code:"RESOURCE_LIMIT_EXCEEDED"});
  await expect(TerrainLightingProbes.bake(source,{grid,rayCount:4097})).rejects.toMatchObject({code:"INVALID_INPUT"});
  const controller=new AbortController();controller.abort();
  await expect(TerrainLightingProbes.bake(source,{grid,signal:controller.signal})).rejects.toMatchObject({code:"REQUEST_CANCELLED"});
 });
});
