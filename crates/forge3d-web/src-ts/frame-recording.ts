import {Forge3DError} from "./runtime-failure.js";
import type {FrameSink,FrameWriteSummary,RenderedFrame} from "./index.js";

/** Owns admission order through the last write and exactly one sink finalization. */
export class FrameRecording {
  readonly #sink:FrameSink;
  readonly #numbering:((index:number)=>string)|undefined;
  #tail:Promise<void>=Promise.resolve();
  #final:Promise<FrameWriteSummary>|undefined;
  #abort:Promise<void>|undefined;
  #failure:unknown;
  #failed=false;
  #accepting=true;
  #settled=false;
  #accepted=0;
  readonly #names:string[]=[];
  readonly #timestamps:number[]=[];
  constructor(sink:FrameSink,numbering?:((index:number)=>string)) {this.#sink=sink;this.#numbering=numbering;}
  get admitted():number {return this.#accepted;}
  get settled():boolean {return this.#settled;}
  write(frame:RenderedFrame):Promise<string> {
    if(!this.#accepting)return Promise.reject(new Forge3DError("INVALID_INPUT","Recording is no longer accepting frames"));
    // Preserve FrameDumper's attempted-frame count, including a failed write.
    const index=this.#accepted++,numbered=this.#numbering?{...frame,index}:frame;
    const name=this.#numbering?.(index);
    const result=this.#tail.then(async()=>{
      if(this.#failed)throw this.#failure;
      try {
        const written=await this.#sink.write(numbered,name);
        this.#names.push(written);this.#timestamps.push(numbered.timestampUs);return written;
      } catch(error) {this.#fail(error);await this.#abortOnce();throw error;}
    });
    // Drain failures without leaving an unhandled internal rejection. Each caller
    // still receives its own rejected write promise.
    this.#tail=result.then(()=>undefined,()=>undefined);
    return result;
  }
  #fail(error:unknown):void {if(!this.#failed){this.#failed=true;this.#failure=error;}this.#accepting=false;}
  #abortOnce():Promise<void> {
    return this.#abort??=Promise.resolve().then(()=>this.#sink.abort?.(this.#failure)).then(()=>undefined,()=>undefined);
  }
  close():Promise<FrameWriteSummary> {
    this.#accepting=false;
    return this.#final??=this.#tail.then(async()=>{
      try {
        if(this.#failed){await this.#abortOnce();throw this.#failure;}
        try {await this.#sink.close?.();}
        catch(error){this.#fail(error);await this.#abortOnce();throw error;}
        return {frames:this.#names.length,names:[...this.#names],timestampsUs:[...this.#timestamps]};
      } finally {this.#settled=true;}
    });
  }
  async abort(error:unknown):Promise<void> {
    this.#fail(error);await this.close().catch(()=>undefined);
  }
  async consume(frames:AsyncIterable<RenderedFrame>|Iterable<RenderedFrame>,signal?:AbortSignal):Promise<FrameWriteSummary> {
    try {
      for await(const frame of frames) {
        if(signal?.aborted)throw new Forge3DError("REQUEST_CANCELLED","Frame recording cancelled",signal.reason);
        await this.write(frame);
      }
      return await this.close();
    } catch(error) {await this.abort(error);throw Forge3DError.from(error);}
  }
}
