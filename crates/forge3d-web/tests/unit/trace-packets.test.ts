import { expect,it } from 'vitest';
import { decodeTraceRecords, readTraceHits, writeTraceHit, TRACE_PARAMS_WGSL } from '../../src-ts/trace-packets.js';
it('decodes independently specified 112-byte AOV records and owns every output',()=>{
 const record=new Float32Array([2,4,6,0, 8,10,12,0, 0,2,0,5, 14,16,18,2, 20,22,24,1, 26,28,30,0, 0,2,0,100]);
 new Uint32Array(record.buffer)[7]=0xffffffff;
 const r=decodeTraceRecords(record,1,1,2);
 expect([...r.color]).toEqual([1,2,3]);expect([...r.albedo]).toEqual([4,5,6]);expect([...r.normal]).toEqual([0,1,0]);
 expect([...r.direct]).toEqual([7,8,9]);expect([...r.indirect]).toEqual([10,11,12]);expect([...r.emission]).toEqual([13,14,15]);
 expect([...r.bentNormal]).toEqual([0,1,0]);expect(r.id[0]).toBe(0xffffffff);expect(r.depth[0]).toBe(5);expect(r.visibility[0]).toBe(1);expect(r.ao[0]).toBe(.5);expect(r.variance[0]).toBeGreaterThan(0);
 record.fill(0);expect(r.depth[0]).toBe(5);
});
it('round trips uint32 hit fields and misses with the independent 64-byte stride',()=>{
 const bytes=new ArrayBuffer(128);const hit={id:0xffffffff,materialId:0xfffffffe,steps:7,t:4,position:[1,2,3] as [number,number,number],normal:[0,1,0] as [number,number,number],barycentric:[.25,.25,.5] as [number,number,number],frontFace:true,kind:'sdf' as const};
 writeTraceHit(bytes,1,hit);expect(readTraceHits(bytes)).toEqual([undefined,hit]);expect(new Uint32Array(bytes)[29]).toBe(0xfffffffe);
 expect(TRACE_PARAMS_WGSL).toContain('extra:vec4f');
});
