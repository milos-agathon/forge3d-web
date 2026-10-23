import {Forge3DError} from './runtime-failure.js';
import type {MemoryByteCacheLike,PersistentByteCache} from './index.js';
const META='forge3d:v:';
/** Session-local entity identity shared by whole-file and ranged transport. */
export class SourceEntities {
 readonly #representations=new Map<string,"whole"|"range">();
 readonly #validators=new Map<string,string>();readonly #sizes=new Map<string,number>();readonly #keys=new Map<string,Set<string>>();readonly #invalid=new Set<string>();
 constructor(readonly memory?:MemoryByteCacheLike,readonly persistent?:PersistentByteCache,readonly pinned=false){}
 check(source:string):void{if(this.#invalid.has(source))throw new Forge3DError('IO_ERROR','Source entity changed; reopen the dataset',{reason:'source-generation-changed',source});}
 current(source:string):string|undefined{this.check(source);return this.#validators.get(source);}
 size(source:string):number|undefined{return this.#sizes.get(source);}
 async validator(source:string):Promise<string|undefined>{this.check(source);const current=this.#validators.get(source);if(current!==undefined)return current;let data:Uint8Array|undefined;try{data=await this.persistent?.get(META+source);}catch{}this.check(source);if(data&&!this.#validators.has(source))this.#validators.set(source,new TextDecoder().decode(data));return this.#validators.get(source);}
 track(source:string,key:string):void{this.check(source);let keys=this.#keys.get(source);if(!keys)this.#keys.set(source,keys=new Set());keys.add(key);}
 async observe(source:string,headers:Headers,total?:number,representation:"whole"|"range"="range"):Promise<void>{
  this.check(source);const etag=headers.get('etag'),modified=headers.get('last-modified');
  const value=etag?`etag:${etag}`:modified?`last-modified:${modified}`:total===undefined?undefined:`size:${total}`;
  const previous=this.#validators.get(source),size=this.#sizes.get(source);
  const oldRepresentation=this.#representations.get(source);
  if(this.pinned&&oldRepresentation!==undefined&&oldRepresentation!==representation&&(!previous||previous.startsWith("size:")||!value||value.startsWith("size:")))await this.invalidate(source);
  this.#representations.set(source,representation);
  if((previous!==undefined&&value!==undefined&&previous!==value)||(size!==undefined&&total!==undefined&&size!==total))await this.invalidate(source);
  this.check(source);if(total!==undefined)this.#sizes.set(source,total);if(value===undefined)return;
  this.#validators.set(source,value);try{await this.persistent?.put(META+source,new TextEncoder().encode(value));}catch{}
  this.check(source);
 }
 async invalidate(source:string):Promise<void>{
  if(this.pinned)this.#invalid.add(source);
  this.#validators.delete(source);this.#sizes.delete(source);const keys=[META+source,...this.#keys.get(source)??[]];this.#keys.delete(source);
  for(const key of keys){this.memory?.delete?.(key);try{await this.persistent?.delete(key);}catch{}}
  this.check(source);
 }
}
export function entityIfMatch(validator:string|undefined):string|undefined{if(!validator?.startsWith('etag:'))return;const etag=validator.slice(5);return etag.startsWith('W/')?undefined:etag;}
