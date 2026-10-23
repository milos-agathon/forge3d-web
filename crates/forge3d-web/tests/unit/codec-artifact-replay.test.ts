import { describe, it, expect } from 'vitest';
import { CodecRegistry } from '../../src-ts/index.js';
import { codecDigest } from '../../src-ts/codec-cache.js';
import { CodecPersistentCache } from '../../src-ts/codec-persistent-cache.js';

describe('verified encoded replay',()=>{
 it.each([null,[],{unknown:true},{schema:2},{parameters:[]}])('rejects malformed header %j and removes invalid content',async patch=>{
  const entries=new Map<string,Uint8Array>();
  const store={async get(k:string){return entries.get(k);},async put(k:string,v:Uint8Array){entries.set(k,v.slice());},async delete(k:string){entries.delete(k);},async clear(){entries.clear();}};
  const r=new CodecRegistry({store});const selection=r.select('hdr');if(selection.status!=='selected')throw Error('hdr');
  const header=patch===null?null:Array.isArray(patch)?patch:{schema:1,format:'hdr',revision:selection.codec.revision,parameters:{},...patch};
  const json=new TextEncoder().encode(JSON.stringify(header)),artifact=new Uint8Array(4+json.length+1);
  new DataView(artifact.buffer).setUint32(0,json.length,true);artifact.set(json,4);
  const key='forge3d-codec-v1/'+await codecDigest(artifact);await new CodecPersistentCache(store,4096).put(key,artifact);
  await expect(r.replay(key)).rejects.toBeDefined();expect(entries.has(key)).toBe(false);await r.dispose();
 });
});
