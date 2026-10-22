import { describe,it,expect,vi } from 'vitest';
import { CogHeightSource } from '../../src-ts/terrain-streaming.js';
import { assembleRasterLevel } from '../../src-ts/raster-level.js';
import type { CogDataset } from '../../src-ts/cog.js';
function cog(read:(x:number,y:number,signal?:AbortSignal)=>Promise<Float32Array>):CogDataset {
 return {width:65,height:33,overviewCount:1,nodata:-9999,ifdInfo:()=>({width:65,height:33,tileWidth:16,tileHeight:16,tilesAcross:5,tilesDown:3}),readTile:(x:number,y:number,_level:number,o:{signal?:AbortSignal})=>read(x,y,o.signal)} as unknown as CogDataset;
}
function tile(x:number,y:number):Float32Array{return Float32Array.from({length:256},(_,i)=>(y*16+Math.floor(i/16))*65+x*16+i%16);}
describe('shared raster level through COG height source',()=>{
 it('clips asymmetric edge tiles and lets a second subscriber finish after the first cancels',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const entered=new Promise<void>(r=>started=r);
  const read=vi.fn(async(x:number,y:number,signal?:AbortSignal)=>{started();await gate;expect(signal?.aborted).toBe(false);return tile(x,y);});
  const source=new CogHeightSource(cog(read)),abort=new AbortController();
  const first=source.readTile(1,0,0,{signal:abort.signal}),second=source.readTile(1,2,1);
  await entered;abort.abort();await expect(first).rejects.toMatchObject({name:'AbortError'});release();
  expect(await second).toEqual(new Float32Array([2144]));expect(read).toHaveBeenCalledTimes(15);expect(source.nodata).toBe(-9999);
  expect(await source.readTile(1,0,0)).toEqual(Float32Array.from({length:256},(_,i)=>Math.floor(i/16)*130+i%16*2));expect(read).toHaveBeenCalledTimes(15);
 });
 it('retries after failure and after all subscribers cancel, without accepting stale completion',async()=>{
  let fail=true;const read=vi.fn(async(x:number,y:number)=>{if(fail){fail=false;throw Error('first read');}return tile(x,y);});
  const source=new CogHeightSource(cog(read));await expect(source.readTile(1,0,0)).rejects.toThrow('first read');expect((await source.readTile(1,0,0))[0]).toBe(0);
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const entered=new Promise<void>(r=>started=r);let first=true;
  const retry=new CogHeightSource(cog(async(x,y,signal)=>{if(first){first=false;started();await gate;expect(signal?.aborted).toBe(true);return new Float32Array(256).fill(999);}return tile(x,y);}));
  const abort=new AbortController(),pending=retry.readTile(1,0,0,{signal:abort.signal});await entered;abort.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});
  expect((await retry.readTile(1,0,0))[0]).toBe(0);release();await Promise.resolve();expect((await retry.readTile(1,0,0))[0]).toBe(0);
 });
 it('rejects wrong tile shapes and output admission before decoding',async()=>{
  const read=vi.fn(async()=>new Float32Array(3));const level={width:3,height:2,tileWidth:2,tileHeight:2,padded:true,readTile:read};
  await expect(assembleRasterLevel({...level,maxBytes:1})).rejects.toMatchObject({code:'RESOURCE_LIMIT_EXCEEDED'});expect(read).not.toHaveBeenCalled();
  await expect(assembleRasterLevel(level)).rejects.toMatchObject({code:'INVALID_INPUT'});
 });
});
