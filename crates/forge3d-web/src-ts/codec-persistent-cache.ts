import { codecDigest } from './codec-cache.js';
import { codecFailure } from './codec-dispatch.js';
import type { PersistentByteStore } from './byte-cache.js';

const INDEX = 'forge3d-codec-v1/index';
const MAX_ENTRIES = 128;
const MAX_INDEX_BYTES = 32768;
const queues = new WeakMap<PersistentByteStore, Promise<unknown>>();
type Entry = { key: string; size: number };

/** Bounded E05 namespace over an application-owned W02 store. */
export class CodecPersistentCache {
  #bytes = 0;
  #entries = 0;
  constructor(readonly store: PersistentByteStore, readonly budgetBytes: number) {}
  stats() { return { bytes:this.#bytes,entries:this.#entries,budgetBytes:this.budgetBytes }; }
  #exclusive<T>(work:()=>Promise<T>):Promise<T> {
    const result=(queues.get(this.store)??Promise.resolve()).catch(()=>{}).then(work);
    queues.set(this.store,result.then(()=>{},()=>{}));
    return result;
  }
  async #encode(entries:Entry[]):Promise<Uint8Array> {
    const data=JSON.stringify(entries),checksum=await codecDigest(new TextEncoder().encode(data));
    return new TextEncoder().encode(JSON.stringify({version:1,entries,checksum}));
  }
  async #load():Promise<Entry[]> {
    const bytes=await this.store.get(INDEX);
    if(!bytes)return [];
    const invalid=()=>codecFailure('IO_ERROR','cache-index-corrupt','Persistent codec index is invalid; clear the application cache namespace');
    if(bytes.length>MAX_INDEX_BYTES)throw invalid();
    let value:any;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw invalid();}
    if(value?.version!==1||!Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES)throw invalid();
    const seen=new Set<string>();
    for(const e of value.entries){
      if(!e||!/^forge3d-codec-v1\/[a-f0-9]{64}$/.test(e.key)||seen.has(e.key)||!Number.isSafeInteger(e.size)||e.size<0)throw invalid();
      seen.add(e.key);
    }
    if(value.checksum!==await codecDigest(new TextEncoder().encode(JSON.stringify(value.entries))))throw invalid();
    return value.entries;
  }
  async #save(entries:Entry[]):Promise<void> {
    let encoded=await this.#encode(entries);
    while(entries.length&&(entries.length>MAX_ENTRIES||entries.reduce((n,e)=>n+e.size,0)+encoded.length>this.budgetBytes||encoded.length>MAX_INDEX_BYTES)){
      await this.store.delete(entries.shift()!.key);encoded=await this.#encode(entries);
    }
    if(!entries.length){await this.store.delete(INDEX);this.#bytes=0;this.#entries=0;return;}
    await this.store.put(INDEX,encoded);
    this.#bytes=encoded.length+entries.reduce((n,e)=>n+e.size,0);this.#entries=entries.length;
  }
  put(key:string,bytes:Uint8Array):Promise<void> {
    return this.#exclusive(async()=>{
      let entries=(await this.#load()).filter(e=>e.key!==key);
      const single=[{key,size:bytes.length}];
      if(bytes.length+(await this.#encode(single)).length>this.budgetBytes){await this.store.delete(key);await this.#save(entries);return;}
      entries.push(single[0]!);
      // Evict before allocating the new stored artifact; include index bytes in the budget.
      let encoded=await this.#encode(entries);
      while(entries.length>MAX_ENTRIES||entries.reduce((n,e)=>n+e.size,0)+encoded.length>this.budgetBytes){
        await this.store.delete(entries.shift()!.key);encoded=await this.#encode(entries);
      }
      await this.store.delete(key);
      await this.#save(entries.filter(e=>e.key!==key));
      try{await this.store.put(key,bytes);await this.#save(entries);}
      catch(error){await this.store.delete(key).catch(()=>{});await this.#save(entries.filter(e=>e.key!==key)).catch(()=>{});throw error;}
    });
  }
  get(key:string):Promise<Uint8Array|undefined> {
    return this.#exclusive(async()=>{
      const entries=(await this.#load()).filter(e=>e.key!==key);
      const bytes=await this.store.get(key);
      if(!bytes){await this.#save(entries);return undefined;}
      if(bytes.length>this.budgetBytes){await this.store.delete(key);await this.#save(entries);throw codecFailure('IO_ERROR','cache-corrupt','Persistent codec artifact exceeds its storage budget');}
      entries.push({key,size:bytes.length});await this.#save(entries);
      return entries.some(e=>e.key===key)?bytes:undefined;
    });
  }
  delete(key:string):Promise<void> {
    return this.#exclusive(async()=>{
      await this.store.delete(key);
      await this.#save((await this.#load()).filter(e=>e.key!==key));
    });
  }
}
