import {expect,it,vi} from 'vitest';
import {RuntimeOperations} from '../../src-ts/runtime-operations.js';
it('shares screenshots, serializes captures and flushes mutations after failure',async()=>{
 const events:string[]=[];let reject!:(e:unknown)=>void;const native=new Promise<Blob>((_,r)=>{reject=r;});const screenshot=vi.fn(()=>native);
 const owner=new RuntimeOperations(()=>events.push('dispose'),e=>events.push(e.message));
 const a=owner.capture('screenshot',screenshot).catch(e=>e.code),b=owner.capture('screenshot',screenshot).catch(e=>e.code);
 owner.mutate(()=>events.push('first'));owner.mutate(()=>{throw Error('mutation failed');});owner.mutate(()=>events.push('last'));
 const c=owner.capture('exclusive',async()=>{events.push('read');return 7;});reject(Error('readback failed'));
 expect(await a).toBe('INTERNAL_ERROR');expect(await b).toBe('INTERNAL_ERROR');expect(await c).toBe(7);expect(screenshot).toHaveBeenCalledTimes(1);expect(events).toEqual(['first','mutation failed','last','read']);
});
it('retains offline mutations and drains before final disposal, discarding queued writes',async()=>{
 const events:string[]=[];let done!:()=>void;const owner=new RuntimeOperations(()=>events.push('dispose'),()=>{});
 owner.beginOffline(()=>events.push('begin'));owner.mutate(()=>events.push('write'));
 const pending=owner.capture('exclusive',()=>new Promise<void>(r=>{done=r;})).catch(e=>e.code);
 expect(()=>owner.beginOffline(()=>{})).toThrow();owner.dispose();expect(events).toEqual(['begin']);done();expect(await pending).toBe('RUNTIME_DISPOSED');expect(events).toEqual(['begin','dispose']);owner.dispose();expect(events).toHaveLength(2);
});
it('keeps offline lease until explicitly ended and then applies queued changes',async()=>{
 const events:string[]=[];const owner=new RuntimeOperations(()=>{},()=>{});owner.beginOffline(()=>{});owner.mutate(()=>events.push('write'));
 await owner.capture('exclusive',async()=>1);expect(events).toEqual([]);expect(owner.endOffline(()=>events.push('end'))).toBe(true);expect(events).toEqual(['end','write']);
});
