import { expect,it } from 'vitest';
import { CodecPersistentCache } from '../../src-ts/codec-persistent-cache.js';
it('plans oversized puts without evicting unrelated entries and bounds every intermediate write',async()=>{
 const data=new Map<string,Uint8Array>();const budget=700;let peak=0;
 const store={async get(k:string){return data.get(k);},async put(k:string,v:Uint8Array){data.set(k,v.slice());peak=Math.max(peak,[...data.values()].reduce((n,b)=>n+b.length,0));},async delete(k:string){data.delete(k);},async clear(){data.clear();}};
 const c=new CodecPersistentCache(store,budget),a='forge3d-codec-v1/'+'a'.repeat(64),b='forge3d-codec-v1/'+'b'.repeat(64);
 await c.put(a,new Uint8Array(200));await c.put(b,new Uint8Array(1000));expect(await c.get(a)).toHaveLength(200);expect(await c.get(b)).toBeUndefined();
 await c.put(b,new Uint8Array(300));expect(peak).toBeLessThanOrEqual(budget);
 await c.delete(b);expect(c.stats().bytes).toBe([...data.values()].reduce((n,v)=>n+v.length,0));
});
it('rejects a corrupt index before any storage mutations',async()=>{
 let mutations=0;const c=new CodecPersistentCache({async get(){return new Uint8Array([1,2]);},async put(){mutations++;},async delete(){mutations++;},async clear(){}},1024);
 await expect(c.delete('forge3d-codec-v1/'+'a'.repeat(64))).rejects.toMatchObject({details:{reason:'cache-index-corrupt'}});expect(mutations).toBe(0);
});
