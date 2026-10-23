import { expect,it,vi } from 'vitest';
import { PathTracer, SdfScene, SdfPrimitive } from '../../src-ts/index.js';
import * as records from '../../src-ts/trace-cpu.js';
it('materializes only observable updates with exactly identical final owned AOVs',async()=>{
 const decode=vi.spyOn(records,'decodeTraceRecords');
 const t=await PathTracer.create({width:3,height:2,backend:'cpu',seed:42});
 await t.setScene({sdf:SdfScene.singlePrimitive(SdfPrimitive.sphere([0,0,0],1))});
 try {
  let dense,sparse;
  for await(const p of t.progressive({spp:4,updateEvery:1}))dense=p.result;
  expect(decode).toHaveBeenCalledTimes(4);decode.mockClear();t.reset();
  for await(const p of t.progressive({spp:4,updateEvery:3}))sparse=p.result;
  expect(decode).toHaveBeenCalledTimes(2);expect(sparse).toEqual(dense);decode.mockClear();
  const final=await t.render({spp:4});expect(decode).toHaveBeenCalledTimes(1);expect(final).toEqual(dense);
  sparse!.color.fill(999);expect(final.color).not.toEqual(sparse!.color);
 }finally{t.dispose();decode.mockRestore();}
});
