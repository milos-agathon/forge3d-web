import {clonePointData,pointDataBytes} from './pointcloud-buffer.js';
import {pointAwait,pointCancelled} from './pointcloud-common.js';
import type {PointData} from './pointcloud-types.js';
interface Production {controller:AbortController;result:Promise<PointData>;subscribers:number;}
/** One validated decode/publication per node, with independently owned subscribers. */
export class PointNodeProduction {
 readonly #pending=new Map<string,Production>();
 async get(key:string,signal:AbortSignal,produce:(signal:AbortSignal)=>Promise<PointData>,publish:(data:PointData)=>PointData):Promise<PointData>{
  pointCancelled(signal);let job=this.#pending.get(key);
  if(!job){
   const controller=new AbortController();
   job={controller,subscribers:0,result:Promise.resolve().then(()=>produce(controller.signal)).then(data=>{pointCancelled(controller.signal);pointDataBytes(data);return publish(data);}).finally(()=>{if(this.#pending.get(key)===job)this.#pending.delete(key);})};
   this.#pending.set(key,job);
  }
  job.subscribers++;
  try{return clonePointData(await pointAwait(job.result,signal));}
  finally{if(--job.subscribers===0){job.controller.abort();if(this.#pending.get(key)===job)this.#pending.delete(key);}}
 }
 dispose():void{for(const job of this.#pending.values())job.controller.abort();this.#pending.clear();}
}
