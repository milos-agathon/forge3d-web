import { Forge3DError } from "./runtime-failure.js";
import type { BrowserByteSource, ByteReadOptions } from "./index.js";

/** One read owns admission, reader cleanup and contiguous output. maxBytes is
 * an output limit; growth/trim can transiently retain two owned allocations. */
export class ByteReadPlan {
  readonly knownBytes:number|undefined;
  readonly #source:BrowserByteSource;
  readonly #options:ByteReadOptions;
  #used=false;
  constructor(source:BrowserByteSource,options:ByteReadOptions={}) {
    this.#source=source;this.#options={...options};
    const max=options.maxBytes;
    if(max!==undefined&&(!Number.isSafeInteger(max)||max<=0))throw new Forge3DError("INVALID_INPUT","maxBytes must be a positive safe integer");
    this.#check();
    this.knownBytes=source instanceof ArrayBuffer||ArrayBuffer.isView(source)?source.byteLength:typeof Blob!=="undefined"&&source instanceof Blob?source.size:undefined;
    if(this.knownBytes!==undefined)this.#admit(this.knownBytes);
  }
  #check():void {if(this.#options.signal?.aborted)throw new Forge3DError("REQUEST_CANCELLED","Read was cancelled");}
  #admit(size:number):void {
    if(!Number.isSafeInteger(size)||size<0||(this.#options.maxBytes!==undefined&&size>this.#options.maxBytes))throw new Forge3DError("RESOURCE_LIMIT_EXCEEDED",`byte source exceeds the ${this.#options.maxBytes??"safe allocation"} byte limit`);
  }
  #progress(loaded:number,total:number|undefined,done:boolean):void {
    this.#options.onProgress?.(total===undefined?{loaded,done}:{loaded,total,done});
  }
  #copy(bytes:Uint8Array):Uint8Array {
    this.#check();this.#admit(bytes.byteLength);
    const result=bytes.slice();this.#progress(result.length,result.length,true);this.#check();return result;
  }
  async read():Promise<Uint8Array> {
    if(this.#used)throw new Forge3DError("INVALID_INPUT","A byte read plan can only be consumed once");
    this.#used=true;this.#check();const source=this.#source;
    if(source instanceof ArrayBuffer)return this.#copy(new Uint8Array(source));
    if(ArrayBuffer.isView(source))return this.#copy(new Uint8Array(source.buffer,source.byteOffset,source.byteLength));
    if(typeof Blob!=="undefined"&&source instanceof Blob)return this.#stream(source.stream(),source.size);
    if(typeof Response!=="undefined"&&source instanceof Response)return this.#response(source);
    if(typeof source==="object"&&source!==null&&typeof (source as ReadableStream<Uint8Array>).getReader==="function")return this.#stream(source as ReadableStream<Uint8Array>);
    if(typeof source==="string"||source instanceof URL) {
      let response:Response;
      try {response=await fetch(typeof source==="string"?source:source.href,{credentials:"same-origin",signal:this.#options.signal??null});}
      catch(error){throw platformError(error);}
      return this.#response(response,String(source));
    }
    throw new Forge3DError("INVALID_INPUT","unsupported byte source");
  }
  async #response(response:Response,url?:string):Promise<Uint8Array> {
    if(!response.ok)throw new Forge3DError("IO_ERROR",`HTTP request failed with status ${response.status}`,{status:response.status,...(url===undefined?{}:{url})});
    const header=response.headers.get("content-length"),length=header===null?NaN:Number(header);
    const total=Number.isSafeInteger(length)&&length>=0?length:undefined;
    if(response.body!==null)return this.#stream(response.body,total);
    if(total!==undefined)this.#admit(total);
    let buffer:ArrayBuffer;try {buffer=await response.arrayBuffer();}catch(error){throw platformError(error);}
    return this.#copy(new Uint8Array(buffer));
  }
  async #stream(stream:ReadableStream<Uint8Array>,total?:number):Promise<Uint8Array> {
    const reader=stream.getReader(),signal=this.#options.signal;
    let cancelled=false,storage=new Uint8Array(0),loaded=0;
    const cancel=():void=>{if(!cancelled){cancelled=true;void reader.cancel().catch(()=>undefined);}};
    signal?.addEventListener("abort",cancel,{once:true});
    try {
      if(total!==undefined)this.#admit(total);
      for(;;) {
        this.#check();const {done,value}=await reader.read();this.#check();if(done)break;
        if(value===undefined)continue;
        if(!(value instanceof ArrayBuffer)&&!ArrayBuffer.isView(value))throw new Forge3DError("INVALID_INPUT","stream chunks must be buffer views");
        const chunk=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength),required=loaded+chunk.byteLength;
        this.#admit(required);
        if(required>storage.length) {
          const capacity=Math.min(this.#options.maxBytes??Number.MAX_SAFE_INTEGER,Math.max(required,storage.length*2));
          const next=new Uint8Array(capacity);next.set(storage.subarray(0,loaded));storage=next;
        }
        storage.set(chunk,loaded);loaded=required;
        this.#progress(loaded,total,false);
      }
      this.#check();const result=loaded===storage.length?storage:storage.slice(0,loaded);
      this.#progress(loaded,total??loaded,true);this.#check();return result;
    } catch(error) {cancel();throw error;}
    finally {signal?.removeEventListener("abort",cancel);reader.releaseLock();}
  }
}
function platformError(error:unknown):Forge3DError {
  if(error instanceof Forge3DError)return error;
  const name=typeof error==="object"&&error!==null?String((error as {name?:unknown}).name??""):"";
  return new Forge3DError(name==="AbortError"?"REQUEST_CANCELLED":name==="QuotaExceededError"?"RESOURCE_LIMIT_EXCEEDED":"IO_ERROR",error instanceof Error?error.message:String(error),error);
}
