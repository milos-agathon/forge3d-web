import {afterEach,expect,it,vi} from 'vitest';
import {encodeVideo,muxEncodedVideo} from '../../src-ts/video.js';
import {Frame} from '../../src-ts/frames.js';
const frame=new Frame(2,2,new Uint8Array(16));
afterEach(()=>vi.unstubAllGlobals());
function encoder({supported=true,stalled=false,bytes=4,closeThrows=false,onDequeue=()=>{}}={}) {
 const copy=vi.fn((data:Uint8Array)=>data.fill(0));const close=vi.fn();
 class Fake extends EventTarget {
  static async isConfigSupported(){return {supported};}
  state='configured';encodeQueueSize=stalled?5:0;
  constructor(readonly callbacks:VideoEncoderInit){super();}
  addEventListener(type:string, listener:EventListenerOrEventListenerObject, options?:AddEventListenerOptions|boolean){super.addEventListener(type,listener,options);if(type==="dequeue")onDequeue();}
  configure(){}
  encode(v:{timestamp:number;duration:number},options:{keyFrame:boolean}){this.callbacks.output({byteLength:bytes,type:options.keyFrame?'key':'delta',timestamp:v.timestamp,duration:v.duration,copyTo:copy} as unknown as EncodedVideoChunk,{});}
  async flush(){}
  close(){close();this.state='closed';if(closeThrows)throw new Error('close failure');}
 }
 vi.stubGlobal('VideoEncoder',Fake);
 vi.stubGlobal('VideoFrame',class {timestamp:number;duration:number;constructor(_data:unknown,options:{timestamp:number;duration:number}){this.timestamp=options.timestamp;this.duration=options.duration;}close(){}});
 return {copy,close};
}
function producer(count=1){let index=0;const returned=vi.fn(async()=>({done:true as const,value:undefined}));return {returned,[Symbol.asyncIterator](){return {next:async()=>index++<count?{done:false as const,value:frame}:{done:true as const,value:undefined},return:returned};}};}
it('closes the yielded producer when codec probing rejects',async()=>{encoder({supported:false});const source=producer();await expect(encodeVideo(source,{fps:30,container:'webm',codec:'vp9'})).rejects.toMatchObject({code:'UNSUPPORTED_FEATURE'});expect(source.returned).toHaveBeenCalledOnce();});
it('cancels an actually stalled dequeue and cleans up despite encoder close failure',async()=>{
 const abort=new AbortController(),waiting=vi.fn(()=>queueMicrotask(()=>abort.abort()));
 const fake=encoder({stalled:true,closeThrows:true,onDequeue:waiting}),source=producer(10);
 await expect(encodeVideo(source,{fps:30,container:'webm',codec:'vp9',signal:abort.signal})).rejects.toMatchObject({code:'REQUEST_CANCELLED'});
 expect(waiting).toHaveBeenCalledOnce();expect(fake.close).toHaveBeenCalledOnce();expect(source.returned).toHaveBeenCalledOnce();
});
it('rejects excess packets before copying them',async()=>{const fake=encoder({bytes:9}),source=producer();await expect(encodeVideo(source,{fps:30,container:'webm',codec:'vp9',maxPacketBytes:8})).rejects.toMatchObject({code:'RESOURCE_LIMIT_EXCEEDED'});expect(fake.copy).not.toHaveBeenCalled();expect(source.returned).toHaveBeenCalledOnce();});
it('streams long sequences with measured bounded retained packet bytes',async()=>{encoder();const result=await encodeVideo(producer(600),{fps:30,container:'webm',codec:'vp9',maxPacketBytes:8,maxOutputBytes:100000});expect(result.frameCount).toBe(600);expect(result.peakPacketBytes).toBe(4);expect(result.keyFrames).toBe(20);expect(result.timestampsUs[599]).toBe(Math.round(599*1e6/30));expect(result.blob.size).toBeLessThan(100000);});
it('enforces the final output byte budget',async()=>{await expect(muxEncodedVideo([{data:new Uint8Array(4),type:'key',timestampUs:0,durationUs:33333}],{width:2,height:2,fps:30,codec:'vp9',container:'webm',maxOutputBytes:8})).rejects.toMatchObject({code:'RESOURCE_LIMIT_EXCEEDED'});});
