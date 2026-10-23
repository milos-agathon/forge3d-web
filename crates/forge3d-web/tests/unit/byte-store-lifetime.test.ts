import {afterEach,expect,it,vi} from 'vitest';
import {indexedDbByteStore} from '../../src-ts/byte-cache.js';
afterEach(()=>vi.unstubAllGlobals());
it('rejects transaction abort after request success and closes connection',async()=>{
 const close=vi.fn();let tx:any;
 const db={objectStoreNames:{contains:()=>true},close,transaction(){tx={objectStore:()=>({put(){const request:any={result:undefined};queueMicrotask(()=>{request.onsuccess();queueMicrotask(()=>{tx.error=new Error('late abort');tx.onabort();});});return request;}})};return tx;}};
 vi.stubGlobal('indexedDB',{open(){const request:any={result:db};queueMicrotask(()=>request.onsuccess());return request;}});
 await expect(indexedDbByteStore('test').put('a',new Uint8Array([1]))).rejects.toThrow('late abort');expect(close).toHaveBeenCalledOnce();
});
it('retries after a failed open and awaits commit',async()=>{
 let opens=0;const close=vi.fn();let complete!:()=>void;
 const db={objectStoreNames:{contains:()=>true},close,transaction(){const tx:any={objectStore:()=>({put(){const request:any={};queueMicrotask(()=>{request.onsuccess();complete=()=>tx.oncomplete();});return request;}})};return tx;}};
 vi.stubGlobal('indexedDB',{open(){const request:any={result:db,error:new Error('open failed')};queueMicrotask(()=>++opens===1?request.onerror():request.onsuccess());return request;}});
 const store=indexedDbByteStore('test');await expect(store.put('a',new Uint8Array())).rejects.toThrow('open failed');
 let settled=false;const pending=store.put('a',new Uint8Array()).then(()=>{settled=true;});await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));expect(settled).toBe(false);complete();await pending;expect(close).toHaveBeenCalledOnce();expect(opens).toBe(2);
});
