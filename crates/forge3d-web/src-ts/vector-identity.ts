import type {VectorFeature} from './vector-types.js';
import {Forge3DError} from './runtime-failure.js';
/** Deterministic allocation in one composition, retaining supplied IDs unless marked imported. */
export class VectorIdentity {
 readonly #used:Set<number>;#next=1;
 constructor(occupied:Iterable<number>=[]){this.#used=new Set(occupied);}
 allocate():number{while(this.#used.has(this.#next))this.#next++;if(this.#next>0xffffffff)throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED','Vector feature ID space exhausted');const id=this.#next++;this.#used.add(id);return id;}
 claim(id:number):void{if(!Number.isInteger(id)||id<1||id>0xffffffff)throw new Forge3DError('INVALID_INPUT','vector feature ID must be a nonzero uint32');if(this.#used.has(id))throw new Forge3DError('INVALID_INPUT',`duplicate feature ID ${id}`);this.#used.add(id);}
 imported(feature:VectorFeature,source:string,sourceId:string|number=feature.id):VectorFeature{return {...structuredClone(feature),id:this.allocate(),properties:{...feature.properties,forge3d_identity:{source,sourceId},forge3d_source_id:feature.properties?.forge3d_source_id??sourceId}};}
 compose(features:readonly VectorFeature[],remap:boolean):VectorFeature[]{return features.map(feature=>{
  const copy=structuredClone(feature),lineage=copy.properties?.forge3d_identity;
  const imported=lineage&&typeof lineage==='object'&&typeof (lineage as {source?:unknown}).source==='string';
  if(remap&&imported&&this.#used.has(copy.id))copy.id=this.allocate();else this.claim(copy.id);
  return copy;
 });}
}
