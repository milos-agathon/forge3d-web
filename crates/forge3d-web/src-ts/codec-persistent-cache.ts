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
  /** Compute the whole final state without storage side effects. */
  async #plan(entries: Entry[]) {
    entries = entries.slice();
    let encoded = await this.#encode(entries);
    while(entries.length && (entries.length > MAX_ENTRIES || encoded.length > MAX_INDEX_BYTES ||
      encoded.length + entries.reduce((n,e)=>n+e.size,0) > this.budgetBytes)) {
      entries.shift(); encoded = await this.#encode(entries);
    }
    return { entries, encoded };
  }
  async #publish(plan: { entries: Entry[]; encoded: Uint8Array }): Promise<void> {
    if(plan.entries.length) await this.store.put(INDEX,plan.encoded);
    else await this.store.delete(INDEX);
    this.#entries=plan.entries.length;
    this.#bytes=plan.entries.length ? plan.encoded.length+plan.entries.reduce((n,e)=>n+e.size,0) : 0;
  }
  /** All mutation, peak admission and partial-write recovery passes through here. */
  #transition(kind: 'put'|'get'|'delete', key: string, input?: Uint8Array): Promise<Uint8Array|undefined> {
    return this.#exclusive(async()=>{
      const previous=await this.#load();
      const bytes=kind==='put'?input:kind==='get'?await this.store.get(key):undefined;
      const oversized=kind==='get' && bytes!==undefined && bytes.length>this.budgetBytes;
      const desired=previous.filter(e=>e.key!==key);
      if(bytes && !oversized && (await this.#plan([{key,size:bytes.length}])).entries.length)
        desired.push({key,size:bytes.length});
      const final=await this.#plan(desired);
      const retained=new Set(final.entries.map(e=>e.key));
      // Delete before either index growth or artifact allocation.
      const removed=new Set(previous.filter(e=>!retained.has(e.key)).map(e=>e.key));
      if(kind==='put'||kind==='delete'||oversized||!retained.has(key))removed.add(key);
      for(const removedKey of removed)await this.store.delete(removedKey);
      if(kind==='put' && retained.has(key)) {
        const rollback=await this.#plan(final.entries.filter(e=>e.key!==key));
        await this.#publish(rollback);
        try { await this.store.put(key,bytes!); await this.#publish(final); }
        catch(error) {
          // The store cannot transact or enumerate; preserve the primary failure and
          // repair the known namespace as far as this adapter permits.
          await this.store.delete(key).catch(()=>{});
          await this.#publish(rollback).catch(()=>{});
          throw error;
        }
      } else await this.#publish(final);
      if(oversized)throw codecFailure('IO_ERROR','cache-corrupt','Persistent codec artifact exceeds its storage budget');
      return retained.has(key)?bytes:undefined;
    });
  }
  put(key:string,bytes:Uint8Array):Promise<void> {
    return this.#transition('put',key,bytes).then(()=>{});
  }
  get(key:string):Promise<Uint8Array|undefined> { return this.#transition('get',key); }
  delete(key:string):Promise<void> { return this.#transition('delete',key).then(()=>{}); }
}
