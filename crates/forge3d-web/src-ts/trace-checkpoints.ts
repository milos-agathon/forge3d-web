import { packTraceScene, traceUniform } from './trace-gpu.js';
import type { TraceGpu } from './trace-gpu.js';
import type { TraceScene } from './trace-scene.js';
import type { CpuTraceSettings } from './trace-cpu.js';
import type { TraceResult } from './trace-types.js';
import type { TraceReservoir, OnlineGuidingGrid } from './trace-sampling.js';
import type { TraceAccumulation } from './trace-accumulation.js';
interface CachedTrace {
  result: TraceResult;
  sum: Float32Array;
  reservoirs: TraceReservoir[];
  gpuReservoirs: ArrayBuffer | undefined;
  guiding: Float32Array | undefined;
}

type State = { accumulation: TraceAccumulation; reservoirs: TraceReservoir[]; guiding: OnlineGuidingGrid | undefined; gpu: TraceGpu | undefined };
/** Owns the complete continuation record, identity, copying and budgeted LRU. */
export class TraceCheckpoints {
  #entries = new Map<string,CachedTrace>();
  #hits = 0;
  #misses = 0;
  capacity = 8;
  get bytes(): number {
    let total=0;
    for(const e of this.#entries.values())total+=this.#cost(e.result,e.sum.byteLength,e.gpuReservoirs?.byteLength??e.reservoirs.length*160,e.guiding?.byteLength??0);
    return total;
  }
  #cost(result: TraceResult, sum: number, reservoirs: number, guiding: number): number {
    return Object.values(result).reduce((n,v)=>n+(ArrayBuffer.isView(v)?v.byteLength:0),0)+sum+reservoirs+guiding+128;
  }
  clear(): void { this.#entries.clear(); this.#hits=0; this.#misses=0; }
  stats() { return {hits:this.#hits,misses:this.#misses,entries:this.#entries.size,bytes:this.bytes}; }
  async key(scene: TraceScene, settings: CpuTraceSettings, backend: string, engine: string, spp: number, admit: (bytes: number) => void): Promise<string> {
    const packed = packTraceScene(
        scene,
        settings.guiding?.snapshot(),
        settings.guiding?.binsPerCell,
      ),
      uniform = traceUniform(scene, settings, packed, 0),
      suffix = new TextEncoder().encode(
        JSON.stringify({ backend: backend, engine: engine, spp }),
      );
    admit(
      2 * packed.bytes.byteLength + uniform.byteLength + suffix.length,
    );
    const bytes = new Uint8Array(
      packed.bytes.byteLength + uniform.byteLength + suffix.length,
    );
    bytes.set(new Uint8Array(packed.bytes));
    bytes.set(new Uint8Array(uniform), packed.bytes.byteLength);
    bytes.set(suffix, packed.bytes.byteLength + uniform.byteLength);
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  }

  restore(key: string, state: State): {result: TraceResult; reservoirs: TraceReservoir[]}|undefined {
    const e=this.#entries.get(key);
    if(!e){this.#misses++;return undefined;}
    this.#entries.delete(key);this.#entries.set(key,e);this.#hits++;
    state.accumulation.restore(e.sum,e.result.samples);
    if(e.guiding)state.guiding!.restore(e.guiding);
    if(state.gpu)state.gpu.restore(state.accumulation.records,e.gpuReservoirs!);
    return {result:structuredClone(e.result),reservoirs:structuredClone(e.reservoirs)};
  }
  async retain(key: string, result: TraceResult, state: State, available: number, check: ()=>void): Promise<void> {
    const pixels=state.accumulation.width*state.accumulation.height;
    const cost=this.#cost(result,state.accumulation.records.byteLength,pixels*(state.gpu?80:160),state.guiding?pixels*state.guiding.binsPerCell*4:0);
    while(this.#entries.size&&(this.#entries.size>=this.capacity||this.bytes+cost>available))this.#entries.delete(this.#entries.keys().next().value!);
    if(cost>available)return;
    const gpuReservoirs=await state.gpu?.exportReservoirs();check();
    this.#entries.set(key,{result:structuredClone(result),sum:state.accumulation.records.slice(),reservoirs:state.gpu?[]:structuredClone(state.reservoirs),gpuReservoirs,guiding:state.guiding?.snapshot()});
  }
}
