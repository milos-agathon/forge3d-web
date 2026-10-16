import { Forge3DError } from './index.js';
import { readByteSource } from './browser-io.js';
import { MemoryByteCache } from './byte-cache.js';
import { CodecPersistentCache } from './codec-persistent-cache.js';
import { CODEC_CATALOG } from './codec-catalog.js';
import { codecFailure, dispatchCodec, normalizeCodecParameters } from './codec-dispatch.js';
import { CODEC_CACHE_PREFIX, codecDigest, packCodecArtifact, unpackCodecArtifact } from './codec-cache.js';
import { dispatchCodecDenoiser, selectCodecDenoiser } from './codec-denoiser.js';
import type { CodecDenoiseTarget, CodecDenoiseOptions, CodecDenoiserSelection } from './codec-denoiser.js';
import { HdrFrame, AovFrame } from './frames.js';
import type { CodecFormat, CodecDecodeOptions, CodecReplayOptions, CodecRegistryOptions, CodecRegistryStats, CodecResult, CodecSelection, CodecSource } from './codec-types.js';

function positive(value:number,name:string):number {
  if(!Number.isSafeInteger(value)||value<1)throw codecFailure('INVALID_INPUT','invalid-registry-limit',`${name} must be a positive safe integer`);
  return value;
}
function abortable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return work;
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(codecFailure('REQUEST_CANCELLED','aborted','Codec denoise was cancelled; submitted GPU work is draining'));
    const finish=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    work.then(value=>{finish();resolve(value);},error=>{finish();reject(error);});
    if(signal.aborted){finish();abort();}
  });
}
/** Integrated E05 dispatch. Platform adapters and feature codecs retain ownership. */
export class CodecRegistry {
  readonly #inputLimit:number;
  readonly #outputLimit:number;
  readonly #workingLimit:number;
  readonly #concurrency:number;
  readonly #cache:MemoryByteCache;
  readonly #persistent:CodecPersistentCache|undefined;
  readonly #disabled:Set<string>;
  readonly #jobs=new Map<AbortController,Promise<unknown>>();
  #workingBytes=0;
  #peakWorkingBytes=0;
  #disposed=false;
  #disposal:Promise<void>|undefined;
  constructor(options:CodecRegistryOptions={}) {
    this.#inputLimit=positive(options.maxInputBytes??64*1024*1024,'maxInputBytes');
    this.#outputLimit=positive(options.maxDecodedBytes??256*1024*1024,'maxDecodedBytes');
    this.#workingLimit=positive(options.maxWorkingBytes??640*1024*1024,'maxWorkingBytes');
    this.#concurrency=positive(options.maxConcurrent??2,'maxConcurrent');
    this.#cache=new MemoryByteCache(positive(options.cacheBytes??16*1024*1024,'cacheBytes'));
    const persistentBudget=positive(options.persistentCacheBytes??64*1024*1024,'persistentCacheBytes');
    this.#persistent=options.store?new CodecPersistentCache(options.store,persistentBudget):undefined;
    this.#disabled=new Set(options.disabled??[]);
    if([...this.#disabled].some(f=>!CODEC_CATALOG.some(c=>c.format===f)))throw codecFailure('INVALID_INPUT','codec-not-registered','disabled contains an unknown codec');
  }
  capabilities():readonly CodecSelection[]{this.#assertLive();return CODEC_CATALOG.map(c=>this.select(c.format));}
  select(format:string):CodecSelection {
    this.#assertLive();const codec=CODEC_CATALOG.find(c=>c.format===format);
    let reason:Extract<CodecSelection,{status:'unavailable'}>['reason']|undefined;
    if(!codec)reason='codec-not-registered';
    else if(this.#disabled.has(format))reason='codec-disabled';
    else if(['exr','laz','ktx2'].includes(format)&&typeof WebAssembly==='undefined')reason='webassembly-unavailable';
    else if(format==='laz'&&(typeof Worker!=='function'||typeof MessageChannel!=='function'))reason='worker-hard-stop-unavailable';
    return reason?{status:'unavailable',format,code:'UNSUPPORTED_FEATURE',reason}:{status:'selected',codec:structuredClone(codec!)};
  }
  decode<F extends CodecFormat>(format:F,source:CodecSource,options:CodecDecodeOptions={}):Promise<CodecResult<F>> {
    return this.#run(options.signal,async signal=>{
      const codec=this.#require(format),parameters=normalizeCodecParameters(format,options.parameters);
      const maxBytes=Math.min(this.#inputLimit,positive(options.maxBytes??this.#inputLimit,'maxBytes'));
      const known=source instanceof ArrayBuffer||ArrayBuffer.isView(source)?source.byteLength:typeof Blob!=='undefined'&&source instanceof Blob?source.size:undefined;
      if(known!==undefined&&known>maxBytes)throw codecFailure('RESOURCE_LIMIT_EXCEEDED','input-byte-limit','Codec input exceeds the encoded byte limit',format);
      const release=this.#reserve((known??maxBytes)*4+16400+this.#outputLimit);
      try{
        const bytes=await readByteSource(source,{maxBytes,signal,...(options.onProgress?{onProgress:options.onProgress}:{})});
        this.#check(signal);
        const artifact=packCodecArtifact(codec,parameters,bytes),cacheKey=CODEC_CACHE_PREFIX+await codecDigest(artifact);
        const value=await this.#dispatch(format,bytes,parameters,signal);this.#check(signal);
        if(this.#persistent)await this.#storage(()=>this.#persistent!.put(cacheKey,artifact.slice()));
        this.#check(signal);this.#cache.put(cacheKey,artifact);return {codec,value,cacheKey};
      }finally{release();}
    });
  }
  replay<F extends CodecFormat>(key:string,options:CodecReplayOptions<F>):Promise<CodecResult<F>>;
  replay(key:string,options?:Pick<CodecDecodeOptions,'signal'>):Promise<CodecResult>;
  replay(key:string,options:Pick<CodecDecodeOptions,'signal'>&{format?:CodecFormat}={}):Promise<CodecResult> {
    return this.#run(options.signal,async signal=>{
      if(!/^forge3d-codec-v1\/[a-f0-9]{64}$/.test(key))throw codecFailure('INVALID_INPUT','invalid-cache-key','Invalid codec cache key');
      const release=this.#reserve(this.#inputLimit*3+8200+this.#outputLimit);
      try{
        let artifact=this.#cache.get(key);
        if(!artifact&&this.#persistent)artifact=await this.#storage(()=>this.#persistent!.get(key));
        this.#check(signal);
        if(!artifact)throw codecFailure('IO_ERROR','cache-miss','Codec artifact is absent');
        let decoded:Awaited<ReturnType<typeof unpackCodecArtifact>>;
        try{
          if(!(artifact instanceof Uint8Array))throw codecFailure('IO_ERROR','cache-corrupt','Invalid cached artifact');
          if(artifact.length>this.#inputLimit+4100)throw codecFailure('RESOURCE_LIMIT_EXCEEDED','input-byte-limit','Cached codec input exceeds this registry limit');
          artifact=artifact.slice();decoded=await unpackCodecArtifact(key,artifact,this.#inputLimit);
          const codec=CODEC_CATALOG.find(c=>c.format===decoded.header.format);
          if(!codec||decoded.header.revision!==codec.revision)throw codecFailure('UNSUPPORTED_FEATURE','cache-incompatible','Codec implementation changed; decode the source again',decoded.header.format);
        }catch(error){if(this.#invalidArtifact(error))await this.#invalidate(key);throw error;}
        const {header,bytes}=decoded;
        if(options.format!==undefined&&options.format!==header.format)throw codecFailure('INVALID_INPUT','cache-format-mismatch','Cached format does not match the requested result type',header.format);
        const codec=this.#require(header.format),parameters=normalizeCodecParameters(header.format,header.parameters);
        let value;
        try{value=await this.#dispatch(header.format,bytes,parameters,signal);}catch(error){if(this.#invalidArtifact(error))await this.#invalidate(key);throw error;}
        this.#check(signal);this.#cache.put(key,artifact);return {codec,value,cacheKey:key};
      }finally{release();}
    });
  }
  denoiserCapability(target?:CodecDenoiseTarget,method:'atrous'|'oidn'='atrous'):CodecDenoiserSelection {
    this.#assertLive();return selectCodecDenoiser(target,method);
  }
  denoise(target:CodecDenoiseTarget,frame:HdrFrame,guides:AovFrame,options:CodecDenoiseOptions={}):Promise<HdrFrame> {
    const work=this.#run(options.signal,async signal=>{
      const selection=selectCodecDenoiser(target,options.settings?.method==='oidn'?'oidn':'atrous');
      if(selection.status==='unavailable')throw codecFailure(selection.code,selection.reason,'A W06 GPU denoise target is required');
      if(!(frame instanceof HdrFrame)||!(guides instanceof AovFrame))throw codecFailure('INVALID_INPUT','invalid-denoise-guides','Matching HDR and AOV frames are required');
      const release=this.#reserve(frame.width*frame.height*68);
      try{const result=await dispatchCodecDenoiser(target,frame,guides,{...options,signal},this.#outputLimit);this.#check(signal);return result;}
      finally{release();}
    });
    // Caller cancellation is prompt. The owned job/slot remains until submitted GPU work drains.
    return abortable(work,options.signal);
  }
  stats():CodecRegistryStats {
    const c=this.#cache.stats(),p=this.#persistent?.stats();
    return {disposed:this.#disposed,activeOperations:this.#jobs.size,cacheBytes:c.bytes,cacheEntries:c.entries,cacheHits:c.hits,cacheMisses:c.misses,
      workingBytes:this.#workingBytes,peakWorkingBytes:this.#peakWorkingBytes,workingBudgetBytes:this.#workingLimit,persistentBytes:p?.bytes??0,persistentEntries:p?.entries??0};
  }
  dispose():Promise<void> {
    if(this.#disposal)return this.#disposal;
    this.#disposed=true;for(const c of this.#jobs.keys())c.abort();this.#cache.clear();
    return this.#disposal=Promise.allSettled([...this.#jobs.values()]).then(()=>{this.#cache.clear();});
  }
  #reserve(bytes:number):()=>void {
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>this.#workingLimit-this.#workingBytes)throw codecFailure('RESOURCE_LIMIT_EXCEEDED','working-byte-limit','Codec transient allocation budget exceeded');
    this.#workingBytes+=bytes;this.#peakWorkingBytes=Math.max(this.#peakWorkingBytes,this.#workingBytes);
    return ()=>{this.#workingBytes-=bytes;};
  }
  #invalidArtifact(error:unknown):boolean {
    if(!(error instanceof Forge3DError))return false;
    const reason=(error.details as {reason?:string}|undefined)?.reason;
    return error.code==='INVALID_INPUT'||reason==='cache-corrupt'||reason==='cache-incompatible';
  }
  async #invalidate(key:string):Promise<void>{this.#cache.delete(key);if(this.#persistent)await this.#storage(()=>this.#persistent!.delete(key));}
  #assertLive():void{if(this.#disposed)throw codecFailure('RUNTIME_DISPOSED','registry-disposed','Codec registry is disposed');}
  #check(signal:AbortSignal):void{this.#assertLive();if(signal.aborted)throw codecFailure('REQUEST_CANCELLED','aborted','Codec operation was cancelled');}
  #require(format:string){const selected=this.select(format);if(selected.status==='unavailable')throw codecFailure(selected.code,selected.reason,`Codec ${format} is unavailable`,format);return selected.codec;}
  async #storage<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){if(error instanceof Forge3DError)throw error;throw codecFailure('IO_ERROR','cache-store-failed',String(error));}}
  async #dispatch<F extends CodecFormat>(format:F,bytes:Uint8Array,parameters:import('./codec-types.js').CodecParameters,signal:AbortSignal){
    try{return await dispatchCodec(format,bytes,parameters,this.#outputLimit,signal);}
    catch(error){this.#check(signal);const e=Forge3DError.from(error),code=error instanceof Forge3DError&&e.code!=='IO_ERROR'?e.code:'INVALID_INPUT';
      throw codecFailure(code,(e.details as {reason?:string}|undefined)?.reason??(code==='UNSUPPORTED_FEATURE'?'codec-capability-unavailable':code==='RESOURCE_LIMIT_EXCEEDED'?'decoded-byte-limit':'corrupt-input'),e.message,format);}
  }
  #run<T>(external:AbortSignal|undefined,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    try{this.#assertLive();}catch(e){return Promise.reject(e);}
    if(this.#jobs.size>=this.#concurrency)return Promise.reject(codecFailure('RESOURCE_LIMIT_EXCEEDED','codec-backpressure','Codec operation limit reached'));
    const c=new AbortController(),abort=()=>c.abort();external?.addEventListener('abort',abort,{once:true});if(external?.aborted)c.abort();
    const job=Promise.resolve().then(()=>{this.#check(c.signal);return operation(c.signal);}).catch(e=>{this.#check(c.signal);throw e;}).finally(()=>{external?.removeEventListener('abort',abort);this.#jobs.delete(c);});
    this.#jobs.set(c,job);return job;
  }
}
