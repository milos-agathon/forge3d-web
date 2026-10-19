import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeApplication, dijkstraSeconds, idwWaterSurface } from '../../examples/migration/application-analysis.js';
const oracle=JSON.parse(readFileSync(new URL('../golden/w23/applications.json',import.meta.url)));
for(const kind of ['rem','bivariate','travel','solar','satellite'])test(`W23 ${kind} analysis matches the unchanged native Python helper`,()=>assert.equal(analyzeApplication(kind,oracle).kind,kind));
test('regional analysis compares numeric results rather than accepting any nonempty output',()=>{
  for(const [kind,mutate]of [['rem',d=>d.rem.waterSurface[0]+=1],['bivariate',d=>d.bivariate.temperatureClasses[0]=4],['travel',d=>d.travel.seconds['1']+=1],['solar',d=>d.solar.factors[0]=0],['satellite',d=>d.satellite.plan[0].scene='wrong']]){const corrupted=structuredClone(oracle);mutate(corrupted);assert.throws(()=>analyzeApplication(kind,corrupted),/Native/);}
});
test('IDW preserves exact river hits and Dijkstra respects inaccessible nodes',()=>{
  assert.deepEqual(idwWaterSurface([[0,0]],[[0,0],[1,1]],[7,100]),[7]);
  assert.deepEqual(dijkstraSeconds({0:[[1,2]],1:[[2,3]]},0,new Set([0,1])),{0:0,1:2});
});
