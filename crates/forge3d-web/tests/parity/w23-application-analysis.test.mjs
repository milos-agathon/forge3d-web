import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { analyzeExample, dijkstraSeconds, idwWaterSurface } from '../../examples/migration/application-analysis.js';
import { executeRegionalKernel } from '../../examples/migration/regional-kernels.js';
const oracle=JSON.parse(readFileSync(new URL('../golden/w23/applications.json',import.meta.url)));
test('IDW preserves exact river hits and Dijkstra respects inaccessible nodes',()=>{
  assert.deepEqual(idwWaterSurface([[0,0]],[[0,0],[1,1]],[7,100]),[7]);
  assert.deepEqual(dijkstraSeconds({0:[[1,2]],1:[[2,3]]},0,new Set([0,1])),{0:0,1:2});
});

for(const name of Object.keys(oracle.examples??{}))test(`original regional computation and dataflow: ${name}`,()=>{
  const result=analyzeExample(name,oracle);
  assert.equal(result.source.path,'examples/'+name);
  assert(result.operations.length>0);
  assert.throws(()=>analyzeExample(name,oracle,()=>({})),/Native/,'Erasing a numerical operation must fail');
  const changed=structuredClone(oracle),operation=changed.examples[name].operations[0];
  function damage(value){for(const key of Object.keys(value)){if(typeof value[key]==='number'){value[key]+=10;return true;}if(value[key]&&typeof value[key]==='object'&&damage(value[key]))return true;}return false;}
  assert(damage(operation.expected));assert.throws(()=>analyzeExample(name,changed),/Native/);
});

test('Platte preserves its own one-meter exact-hit rule and PNOA never dispatches to REM',()=>{
  const colorado=executeRegionalKernel('colorado-idw',oracle.rem,{idwWaterSurface}),platte=executeRegionalKernel('platte-idw',oracle.rem,{});
  assert(Math.max(...platte.waterSurface.map((v,i)=>Math.abs(v-colorado.waterSurface[i])))>=.49);
  for(const name of ['pnoa_river_showcase.py','pnoa_river_showcase_video.py'])assert(!analyzeExample(name,oracle).operations.some(o=>o.kernel.includes('idw')));
});

test('recorded source windows and spatial analysis outputs reach the rendered inputs',()=>{
  const captured=JSON.parse(readFileSync(new URL('../fixtures/w23/regional-dem-inputs.json',import.meta.url)));
  assert.equal(Object.keys(captured.examples).length,7);
  assert.equal(captured.examples['pnoa_river_showcase.py'].source.path,'assets/tif/Bryce_Canyon.tif');
  assert.equal(oracle.examples['pnoa_river_showcase.py'].terrain.source.path,'assets/tif/Bryce_Canyon.tif');
  for(const [name,input]of Object.entries(captured.examples)){
    const bytes=Buffer.alloc(input.data.length*4);input.data.forEach((v,i)=>bytes.writeFloatLE(v,i*4));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),input.source.convertedSha256,name);
    assert.deepEqual(oracle.examples[name].terrain.data,input.data,name);
  }
  const poland=analyzeExample('poland_river_basins_forge3d.py',oracle);
  assert.deepEqual(poland.terrain,poland.evidence.decoded);
  const climate=analyzeExample('belgium_bivariate_climate_map.py',oracle);
  assert.equal(climate.colors.length,climate.width*climate.height);
  assert.equal(climate.colors[0],climate.colors[3]);
  assert.equal(climate.colors[0],climate.colors[3*climate.width]);
});
