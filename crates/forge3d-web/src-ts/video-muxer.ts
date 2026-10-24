import {Forge3DError} from "./runtime-failure.js";
import type {EncodedVideoChunkInput,MuxVideoOptions,VideoCodecName} from "./index.js";
import {CODEC_STRINGS,MIME_TYPES,MP4_EPOCH_OFFSET_SECONDS,invalid,positiveInteger,requestedCodecs} from "./video-codecs.js";
interface Output {addVideoTrack(source:unknown,metadata:{frameRate:number}):void;start():Promise<void>;finalize():Promise<void>;cancel():Promise<void>;}
interface PacketSource {add(packet:unknown,metadata?:EncodedVideoChunkMetadata):Promise<void>;}
interface Bunny {
 Output:new(options:{format:unknown;target:unknown})=>Output;
 Mp4OutputFormat:new(options:{fastStart:false})=>unknown;
 WebMOutputFormat:new()=>unknown;
 StreamTarget:new(stream:WritableStream<{type:"write";data:Uint8Array;position:number}>,options:{chunked:false})=>unknown;
 EncodedVideoPacketSource:new(codec:VideoCodecName)=>PacketSource;
 EncodedPacket:new(data:Uint8Array,type:"key"|"delta",timestamp:number,duration:number)=>unknown;
}
let pending:Promise<Bunny>|undefined;
function load():Promise<Bunny> {
 return pending??=import("mediabunny").then(m=>m as unknown as Bunny,error=>{pending=undefined;throw new Forge3DError("WASM_LOAD_FAILED","Failed to load the MP4/WebM muxer",error);});
}
export interface VideoMuxer {add(chunk:EncodedVideoChunkInput,metadata?:EncodedVideoChunkMetadata):Promise<void>;finish():Promise<Blob>;cancel():Promise<void>;}
export async function createVideoMuxer(options:MuxVideoOptions):Promise<VideoMuxer> {
 const container=options.container??"mp4";requestedCodecs(container,options.codec);
 const width=positiveInteger("width",options.width),height=positiveInteger("height",options.height),fps=positiveInteger("fps",options.fps);
 const limit=positiveInteger("maxOutputBytes",options.maxOutputBytes??256*1024*1024);
 const bunny=await load();let storage=new Uint8Array(0),length=0,packets=0,finished=false;
 const target=new bunny.StreamTarget(new WritableStream({write({data,position}) {
  const end=position+data.byteLength;
  if(!Number.isSafeInteger(end)||position<0||end>limit)throw new Forge3DError("RESOURCE_LIMIT_EXCEEDED",`Video output exceeds ${limit} bytes`);
  if(end>storage.length){const next=new Uint8Array(Math.min(limit,Math.max(end,storage.length*2)));next.set(storage);storage=next;}
  storage.set(data,position);length=Math.max(length,end);
 }}),{chunked:false});
 // Stream packets immediately instead of retaining the entire MP4 in the muxer.
 const output=new bunny.Output({format:container==="mp4"?new bunny.Mp4OutputFormat({fastStart:false}):new bunny.WebMOutputFormat(),target});
 const internal=(output as unknown as {_muxer?:{creationTime?:number}})._muxer;
 if(internal&&"creationTime" in internal){const created=options.creationTime??0;internal.creationTime=MP4_EPOCH_OFFSET_SECONDS+Math.floor((created instanceof Date?created.getTime():created)/1000);}
 const source=new bunny.EncodedVideoPacketSource(options.codec);output.addVideoTrack(source,{frameRate:fps});
 try {await output.start();}catch(error){await output.cancel().catch(()=>undefined);throw error;}
 let cancelled:Promise<void>|undefined;
 return {
  async add(chunk,metadata) {
   if(finished||cancelled)throw invalid("Video muxer is finalized");
   if(packets===0&&chunk.type!=="key")throw invalid("the first chunk must be a key frame");
   const decoderConfig=metadata?.decoderConfig??options.decoderConfig??{codec:options.codecString??CODEC_STRINGS[options.codec][0]??options.codec,codedWidth:width,codedHeight:height};
   await source.add(new bunny.EncodedPacket(chunk.data,chunk.type,chunk.timestampUs/1e6,chunk.durationUs/1e6),packets++===0?{decoderConfig}:undefined);
  },
  async finish() {if(packets===0)throw invalid("muxEncodedVideo requires at least one chunk");await output.finalize();finished=true;return new Blob([storage.subarray(0,length)],{type:MIME_TYPES[container]});},
  cancel() {if(finished)return Promise.resolve();return cancelled??=output.cancel().catch(()=>undefined).then(()=>{storage=new Uint8Array(0);});},
 };
}
export async function muxEncodedVideo(chunks:readonly EncodedVideoChunkInput[],options:MuxVideoOptions):Promise<Blob> {
 if(chunks.length===0)throw invalid("muxEncodedVideo requires at least one chunk");
 if(chunks[0]?.type!=="key")throw invalid("the first chunk must be a key frame");
 const muxer=await createVideoMuxer(options);
 try {for(const chunk of chunks)await muxer.add(chunk);return await muxer.finish();}
 catch(error){await muxer.cancel();if(error instanceof Forge3DError)throw error;throw new Forge3DError("IO_ERROR","Video muxing failed",error);}
}
