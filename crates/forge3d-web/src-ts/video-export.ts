import {Forge3DError} from "./runtime-failure.js";
import {Frame} from "./frames.js";
import {frameTimestampUs} from "./frame-stream.js";
import type {RenderedFrame,VideoEncodeOptions,EncodedVideoResult} from "./index.js";
import {createVideoMuxer,type VideoMuxer} from "./video-muxer.js";
import {positiveInteger,requestedCodecs,defaultBitrate,probeVideoCodecs,unavailable,invalid,MIME_TYPES} from "./video-codecs.js";

class ExportLifetime {
 readonly #signal:AbortSignal|undefined;
 readonly #failure:Promise<never>;
 #reject!:(error:unknown)=>void;
 #failed=false;
 error:unknown;
 readonly #abort=()=>this.fail(new Forge3DError("REQUEST_CANCELLED","Video encoding was cancelled",this.#signal?.reason));
 constructor(signal?:AbortSignal){this.#signal=signal;this.#failure=new Promise((_,reject)=>{this.#reject=reject;});void this.#failure.catch(()=>undefined);signal?.addEventListener("abort",this.#abort,{once:true});if(signal?.aborted)this.#abort();}
 fail(error:unknown):void {if(!this.#failed){this.#failed=true;this.error=error;this.#reject(error);}}
 check():void {if(this.#failed)throw this.error;}
 wait<T>(promise:PromiseLike<T>):Promise<T>{return Promise.race([Promise.resolve(promise),this.#failure]);}
 dispose():void {this.#signal?.removeEventListener("abort",this.#abort);}
}
/** Owns the producer, encoder, bounded packet queue and muxer until final output. */
export async function encodeVideo(frames:Iterable<Frame|RenderedFrame>|AsyncIterable<Frame|RenderedFrame>,options:VideoEncodeOptions):Promise<EncodedVideoResult> {
 const fps=positiveInteger("fps",options.fps),container=options.container??"mp4",requested=requestedCodecs(container,options.codec);
 const keyInterval=positiveInteger("keyFrameInterval",options.keyFrameInterval??fps),packetLimit=positiveInteger("maxPacketBytes",options.maxPacketBytes??8*1024*1024);
 positiveInteger("maxOutputBytes",options.maxOutputBytes??256*1024*1024);
 const scope=new ExportLifetime(options.signal);
 let iterator:Iterator<Frame|RenderedFrame>|AsyncIterator<Frame|RenderedFrame>|undefined;
 let encoder:VideoEncoder|undefined,muxer:VideoMuxer|undefined,done=false,completed=false;
 let tail=Promise.resolve(),pendingBytes=0,peakPacketBytes=0,keyFrames=0;
 try {
  iterator=Symbol.asyncIterator in frames?(frames as AsyncIterable<Frame|RenderedFrame>)[Symbol.asyncIterator]():(frames as Iterable<Frame|RenderedFrame>)[Symbol.iterator]();
  scope.check();let current=await scope.wait(Promise.resolve(iterator.next()));
  if(current.done){done=true;throw invalid("encodeVideo requires at least one frame");}
  const first=current.value instanceof Frame?current.value:current.value.frame,{width,height}=first;
  const bitrate=options.bitrate??defaultBitrate(width,height,fps);
  const probes=await scope.wait(probeVideoCodecs({width,height,fps,container,codec:requested,bitrate})),selected=probes.find(p=>p.supported);
  if(!selected)throw unavailable(container,requested,probes);
  // Retain the pending creation promise so cancellation cannot orphan a muxer.
  const creating=createVideoMuxer({codec:selected.codec,codecString:selected.codecString,container,width,height,fps,...(options.creationTime===undefined?{}:{creationTime:options.creationTime}),...(options.maxOutputBytes===undefined?{}:{maxOutputBytes:options.maxOutputBytes})});
  muxer=await creating;scope.check();
  encoder=new VideoEncoder({error:error=>scope.fail(error),output(chunk,metadata){
   try {
    scope.check();
    if(chunk.byteLength>packetLimit-pendingBytes)throw new Forge3DError("RESOURCE_LIMIT_EXCEEDED",`Video packets exceed ${packetLimit} retained bytes`);
    const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);pendingBytes+=data.length;peakPacketBytes=Math.max(peakPacketBytes,pendingBytes);if(chunk.type==="key")keyFrames++;
    tail=tail.then(async()=>{scope.check();await muxer!.add({data,type:chunk.type,timestampUs:chunk.timestamp,durationUs:chunk.duration??0},metadata);}).catch(error=>scope.fail(error)).finally(()=>{pendingBytes-=data.length;});
   }catch(error){scope.fail(error);}
  }});
  encoder.configure({codec:selected.codecString,width,height,framerate:fps,bitrate,latencyMode:"quality",...(selected.codec==="avc"?{avc:{format:"avc" as const}}:{})});
  const timestampsUs:number[]=[];let index=0;
  while(!current.done) {
   scope.check();const frame=current.value instanceof Frame?current.value:current.value.frame;
   if(frame.width!==width||frame.height!==height)throw invalid(`frame ${index} is ${frame.width}x${frame.height}; expected ${width}x${height}`);
   const timestamp=frameTimestampUs(index,fps),duration=frameTimestampUs(index+1,fps)-timestamp;
   const vf=new VideoFrame(frame.data as Uint8Array<ArrayBuffer>,{format:"RGBA",codedWidth:width,codedHeight:height,timestamp,duration});
   try{encoder.encode(vf,{keyFrame:index%keyInterval===0});}finally{vf.close();}
   timestampsUs.push(timestamp);index++;options.onProgress?.(index);scope.check();
   while(encoder.encodeQueueSize>4) {
    let listener!:()=>void;
    const dequeue=new Promise<void>(resolve=>{listener=resolve;encoder!.addEventListener("dequeue",listener);if(encoder!.encodeQueueSize<=4)resolve();});
    try{await scope.wait(dequeue);}finally{encoder.removeEventListener("dequeue",listener);}
   }
   // Propagate muxer backpressure before accepting the next producer frame.
   await scope.wait(tail);scope.check();current=await scope.wait(Promise.resolve(iterator.next()));
  }
  done=true;await scope.wait(encoder.flush());await scope.wait(tail);scope.check();
  const blob=await scope.wait(muxer.finish());completed=true;
  return {blob,mimeType:MIME_TYPES[container],container,codec:selected.codec,codecString:selected.codecString,width,height,fps,frameCount:index,timestampsUs,durationUs:frameTimestampUs(index,fps),keyFrames,peakPacketBytes};
 }catch(error){scope.fail(error);throw Forge3DError.from(error);}
 finally {
  try{if(encoder&&encoder.state!=="closed")encoder.close();}catch{/* Continue cleanup after a driver close failure. */}
  try { if(!completed)await muxer?.cancel(); } catch { /* Preserve export failure and continue producer cleanup. */ }
  await tail;
  if(!done)try{await iterator?.return?.();}catch{/* Preserve the original export failure. */}
  scope.dispose();
 }
}
