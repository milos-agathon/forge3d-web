import {expect,it,vi} from 'vitest';
import {planGeoJson} from '../../src-ts/crs-geometry-plan.js';
it('rejects oversized topology before cloning input',()=>{const clone=vi.spyOn(globalThis,'structuredClone');try{expect(()=>planGeoJson({type:'MultiPoint',coordinates:[[0,0],[1,1]]},1)).toThrow('maxPoints');expect(clone).not.toHaveBeenCalled();}finally{clone.mockRestore();}});
it('admits metadata copy cost and recomputes mixed dimensional ancestor bounds',()=>{
 expect(()=>planGeoJson({type:'Point',coordinates:[0,0],properties:{large:'x'.repeat(40000)}} as any,1)).toThrow('copy budget');
 const input={type:'GeometryCollection',bbox:[99,99,100,100],geometries:[{type:'Point',coordinates:[1,2,3],bbox:[0,0,0,0,0,0]},{type:'Point',coordinates:[4,5]}],custom:{keep:true}} as any;
 const plan=planGeoJson(input,2),copy=plan.copy(input);plan.apply(copy,0,[10,20,30]);plan.apply(copy,1,[40,50]);plan.finish(copy);expect(copy.bbox).toEqual([10,20,40,50]);expect(copy.geometries[0].bbox).toEqual([10,20,30,10,20,30]);expect(copy.custom).toEqual({keep:true});expect(input.geometries[0].coordinates).toEqual([1,2,3]);
});
