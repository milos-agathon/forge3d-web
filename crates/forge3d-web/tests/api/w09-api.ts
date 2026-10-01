import {
  Forge3DScene, Forge3DRuntime, Forge3DViewer, Forge3DSession,
  TerrainScatterBatch, TerrainScatterSource, TerrainLightingProbes,
  ScatterWindSettings, makeScatterTransform, seededScatterTransforms,
  gridScatterTransforms, autoScatterLodLevels,
  getTerrainProbeMaterialDefaults,
  type ScatterMesh, type ScatterFrameStats,
} from "../../types/index.js";
const source = new TerrainScatterSource(new Float32Array(4),2,2,{terrainWidth:2,origin:[0,0]});
const mesh:ScatterMesh={positions:new Float32Array(9),normals:new Float32Array(9),indices:new Uint32Array(3)};
const batch = new TerrainScatterBatch({levels:autoScatterLodLevels(mesh),transforms:makeScatterTransform([0,0,0]),wind:new ScatterWindSettings().snapshot()});
seededScatterTransforms(source,{count:1,seed:42});gridScatterTransforms(source,{spacing:1,mask:{data:new Float32Array(6),width:3,height:2}});
const scene=Forge3DScene.create();scene.setScatterBatches([batch]);scene.setTimeSeconds(.37);
async function probes(runtime:Forge3DRuntime,viewer:Forge3DViewer,session:Forge3DSession) {
 const p=await TerrainLightingProbes.bake(source,{grid:{origin:[0,0],spacing:[1,1],dims:[1,1]},reflectionGrid:{origin:[0,0],spacing:[1,1],dims:[1,1]},reflectionMaterial:getTerrainProbeMaterialDefaults()});
 scene.setLightingProbes(p);runtime.setLightingProbes(p);viewer.setLightingProbes(p);
 runtime.setScatterBatches([batch]);viewer.setScatterBatches([batch]);
 runtime.setTimeSeconds(.37);viewer.setTimeSeconds(.37);session.setTimeSeconds(.37);
 const stats:ScatterFrameStats=runtime.getScatterStats();
 return [stats,viewer.getProbeMemoryReport(),session.getScatterMemoryReport()];
}
void probes;
