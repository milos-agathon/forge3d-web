import { CodecOperations } from './codec-operations.js';
import { Forge3DError } from './runtime-failure.js';
import { ByteReadPlan } from './byte-materialization.js';
import { MemoryByteCache } from './byte-cache.js';
import { CodecPersistentCache } from './codec-persistent-cache.js';
import { CODEC_CATALOG } from './codec-catalog.js';
import { codecFailure, dispatchCodec, normalizeCodecParameters } from './codec-dispatch.js';
import { CODEC_CACHE_PREFIX, assertCodecCacheKey, invalidCodecArtifact, codecDigest, packCodecArtifact, verifyCodecArtifact } from './codec-cache.js';
import { dispatchCodecDenoiser, selectCodecDenoiser } from './codec-denoiser.js';
import type { CodecDenoiseTarget, CodecDenoiseOptions, CodecDenoiserSelection } from './codec-denoiser.js';
import { HdrFrame, AovFrame } from './frames.js';
import type { CodecFormat, CodecDecodeOptions, CodecReplayOptions, CodecRegistryOptions, CodecRegistryStats, CodecResult, CodecSelection, CodecSource } from './codec-types.js';

function positive(value:number,name:string):number {
  if(!Number.isSafeInteger(value)||value<1)throw codecFailure('INVALID_INPUT','invalid-registry-limit',`${name} must be a positive safe integer`);
  return value;
}
/** Integrated E05 dispatch. Platform adapters and feature codecs retain ownership. */
export class CodecRegistry {
  readonly #inputLimit:number;
  readonly #outputLimit:number;
  readonly #cache:MemoryByteCache;
  readonly #persistent:CodecPersistentCache|undefined;
  readonly #disabled:Set<string>;
  readonly #operations:CodecOperations;
  constructor(options:CodecRegistryOptions={}) {
    this.#inputLimit=positive(options.maxInputBytes??64*1024*1024,'maxInputBytes');
    this.#outputLimit=positive(options.maxDecodedBytes??256*1024*1024,'maxDecodedBytes');
    const workingLimit=positive(options.maxWorkingBytes??640*1024*1024,'maxWorkingBytes');
    const concurrency=positive(options.maxConcurrent??2,'maxConcurrent');
    this.#operations=new CodecOperations(workingLimit,concurrency,()=>this.#cache.clear());
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
    return this.#operations.run(options.signal,async (signal,reserve)=>{
      const codec=this.#require(format),parameters=normalizeCodecParameters(format,options.parameters);
      const maxBytes=Math.min(this.#inputLimit,positive(options.maxBytes??this.#inputLimit,'maxBytes'));
      let read:ByteReadPlan;
      try {read=new ByteReadPlan(source,{maxBytes,signal,...(options.onProgress?{onProgress:options.onProgress}:{})});}
      catch(error) {
        if(error instanceof Forge3DError&&error.code==='RESOURCE_LIMIT_EXCEEDED')throw codecFailure('RESOURCE_LIMIT_EXCEEDED','input-byte-limit','Codec input exceeds the encoded byte limit',format);
        throw error;
      }
      reserve((read.knownBytes??maxBytes)*4+16400+this.#outputLimit);
      {
        const bytes=await read.read();
        this.#check(signal);
        const artifact=packCodecArtifact(codec,parameters,bytes),cacheKey=CODEC_CACHE_PREFIX+await codecDigest(artifact);
        const value=await this.#dispatch(format,bytes,parameters,signal);this.#check(signal);
        if(this.#persistent)await this.#storage(()=>this.#persistent!.put(cacheKey,artifact.slice()));
        this.#check(signal);this.#cache.put(cacheKey,artifact);return {codec,value,cacheKey};
      }
    });
  }
  replay<F extends CodecFormat>(key:string,options:CodecReplayOptions<F>):Promise<CodecResult<F>>;
  replay(key:string,options?:Pick<CodecDecodeOptions,'signal'>):Promise<CodecResult>;
  replay(key:string,options:Pick<CodecDecodeOptions,'signal'>&{format?:CodecFormat}={}):Promise<CodecResult> {
    return this.#operations.run(options.signal,async (signal,reserve)=>{
      assertCodecCacheKey(key);
      reserve(this.#inputLimit*3+8200+this.#outputLimit);
      {
        let artifact=this.#cache.get(key);
        if(!artifact&&this.#persistent)artifact=await this.#storage(()=>this.#persistent!.get(key));
        this.#check(signal);
        if(!artifact)throw codecFailure('IO_ERROR','cache-miss','Codec artifact is absent');
        let decoded:Awaited<ReturnType<typeof verifyCodecArtifact>>;
        try{decoded=await verifyCodecArtifact(key,artifact,this.#inputLimit);}
        catch(error){if(invalidCodecArtifact(error))await this.#invalidate(key);throw error;}
        const {format,bytes,parameters}=decoded;
        if(options.format!==undefined&&options.format!==format)throw codecFailure('INVALID_INPUT','cache-format-mismatch','Cached format does not match the requested result type',format);
        const codec=this.#require(format);
        let value;
        try{value=await this.#dispatch(format,bytes,parameters,signal);}catch(error){if(invalidCodecArtifact(error))await this.#invalidate(key);throw error;}
        this.#check(signal);this.#cache.put(key,decoded.artifact);return {codec,value,cacheKey:key};
      }
    });
  }
  denoiserCapability(target?:CodecDenoiseTarget,method:'atrous'|'oidn'='atrous'):CodecDenoiserSelection {
    this.#assertLive();return selectCodecDenoiser(target,method);
  }
  denoise(target:CodecDenoiseTarget,frame:HdrFrame,guides:AovFrame,options:CodecDenoiseOptions={}):Promise<HdrFrame> {
    const work=this.#operations.run(options.signal,async (signal,reserve)=>{
      const selection=selectCodecDenoiser(target,options.settings?.method==='oidn'?'oidn':'atrous');
      if(selection.status==='unavailable')throw codecFailure(selection.code,selection.reason,'A W06 GPU denoise target is required');
      if(!(frame instanceof HdrFrame)||!(guides instanceof AovFrame))throw codecFailure('INVALID_INPUT','invalid-denoise-guides','Matching HDR and AOV frames are required');
      reserve(frame.width*frame.height*68);
      {const result=await dispatchCodecDenoiser(target,frame,guides,{...options,signal},this.#outputLimit);this.#check(signal);return result;}
    });
    // Caller cancellation is prompt. The owned job/slot remains until submitted GPU work drains.
    return work;
  }
  stats():CodecRegistryStats {
    const c=this.#cache.stats(),p=this.#persistent?.stats();
    return {...this.#operations.stats(),cacheBytes:c.bytes,cacheEntries:c.entries,cacheHits:c.hits,cacheMisses:c.misses,
      persistentBytes:p?.bytes??0,persistentEntries:p?.entries??0};
  }
  dispose():Promise<void> {
    this.#cache.clear();
    return this.#operations.dispose();
  }
  async #invalidate(key:string):Promise<void>{this.#cache.delete(key);if(this.#persistent)await this.#storage(()=>this.#persistent!.delete(key));}
  #assertLive():void{this.#operations.assertLive();}
  #check(signal:AbortSignal):void{this.#operations.check(signal);}
  #require(format:string){const selected=this.select(format);if(selected.status==='unavailable')throw codecFailure(selected.code,selected.reason,`Codec ${format} is unavailable`,format);return selected.codec;}
  async #storage<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){if(error instanceof Forge3DError)throw error;throw codecFailure('IO_ERROR','cache-store-failed',String(error));}}
  async #dispatch<F extends CodecFormat>(format:F,bytes:Uint8Array,parameters:import('./codec-types.js').CodecParameters,signal:AbortSignal){
    try{return await dispatchCodec(format,bytes,parameters,this.#outputLimit,signal);}
    catch(error){this.#check(signal);const e=Forge3DError.from(error),code=error instanceof Forge3DError&&e.code!=='IO_ERROR'?e.code:'INVALID_INPUT';
      throw codecFailure(code,(e.details as {reason?:string}|undefined)?.reason??(code==='UNSUPPORTED_FEATURE'?'codec-capability-unavailable':code==='RESOURCE_LIMIT_EXCEEDED'?'decoded-byte-limit':'corrupt-input'),e.message,format);}
  }
}
