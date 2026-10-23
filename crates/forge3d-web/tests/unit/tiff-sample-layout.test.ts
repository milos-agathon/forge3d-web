import {expect,it} from 'vitest';
import {TiffSampleLayout} from '../../src-ts/tiff-sample-layout.js';
const params={tileWidth:2,tileHeight:2,planarConfiguration:1,bitsPerSample:[8],predictor:1,samplesPerPixel:3};
it('validates every sample and uses complete interleaved offsets',()=>{
 const layout=new TiffSampleLayout({...params,bitsPerSample:[8,16,8]},[1]);expect(()=>layout.requireRgba()).toThrow('uint8');
 const bytes=new Uint8Array([1,2,0,3,4,5,0,6]);expect([...layout.numeric(bytes.buffer,1,true,1)]).toEqual([2,5,0,0]);expect(()=>layout.numeric(bytes.buffer.slice(0,7),1,true,1)).toThrow('truncated');
 expect(()=>new TiffSampleLayout(params,[1,2])).toThrow('layout');expect(()=>new TiffSampleLayout(params,[1,1,3]).requireRgba()).toThrow();
});
it('uses planar addressing and admits short edge-strip spans before output allocation',()=>{
 const layout=new TiffSampleLayout({...params,planarConfiguration:2},[1]);expect(layout.tileIndex(1,2,2,4,3)).toBe(33);expect([...layout.numeric(new Uint8Array([8,9]).buffer,2,true,1)]).toEqual([8,9,0,0]);expect(()=>layout.numeric(new Uint8Array([8]).buffer,2,true,1)).toThrow('truncated');layout.requireRgba();
});
