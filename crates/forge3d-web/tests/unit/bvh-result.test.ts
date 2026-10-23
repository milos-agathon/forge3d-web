import {expect,it} from 'vitest';
import {BvhHandle} from '../../src-ts/bvh.js';
const primitives=[{id:1,v0:[0,0,0] as [number,number,number],v1:[1,0,0] as [number,number,number],v2:[0,1,0] as [number,number,number]}];
it('rejects invalid complete results without changing installed state',()=>{
 const tree=new BvhHandle(primitives),before=tree.packNodes(),report=tree.getProperties();
 for(const result of [{...tree,triangles:tree.triangles,nodes:tree.nodes,indices:new Uint32Array([1]),stats:tree.stats},{triangles:tree.triangles,nodes:[{...tree.nodes[0]!,count:2}],indices:tree.indices,stats:tree.stats}])expect(()=>tree.install(result)).toThrow();
 expect(tree.packNodes()).toEqual(before);expect(tree.getProperties()).toEqual(report);
});
it('keeps live query and report unchanged throughout a failed refit',async()=>{
 const tree=new BvhHandle(primitives),report=tree.getProperties(),ray={origin:[.2,.2,1] as [number,number,number],direction:[0,0,-1] as [number,number,number]},hit=tree.intersect(ray);
 await expect(tree.refitOwned([{...primitives[0]!,v0:[0,0,-1]}],async candidate=>{expect(new Uint8Array(candidate.packTriangles())).not.toEqual(new Uint8Array(tree.packTriangles()));expect(tree.intersect(ray)).toEqual(hit);throw new Error('GPU readback failed');})).rejects.toThrow('GPU readback failed');
 expect(tree.intersect(ray)).toEqual(hit);expect(tree.getProperties()).toEqual(report);
});
