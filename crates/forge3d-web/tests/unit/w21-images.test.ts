import { describe, it, expect, vi, afterEach } from 'vitest';
import { deflateSync } from 'node:zlib';
import { arrayToPng, pngToArray, imageArrayToRgba, imageArrayToImageData, displayImageArray } from '../../src-ts/image-array.js';
import { decodePng } from '../../src-ts/png-decode.js';
import { encodePng } from '../../src-ts/frames.js';
import { loadImage, exportImage } from '../../src-ts/image-io.js';

// Independent PNG fixture writer: only standard zlib and PNG chunks, no production encoder.
export function chunk(name: string, bytes: Uint8Array): Buffer {
  const content = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const out = Buffer.alloc(content.length + 8); out.writeUInt32BE(bytes.length); content.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
export function png(w: number, h: number, depth: number, type: number, raw: number[], extra: Buffer[] = [], interlace = 0): Uint8Array {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header.set([depth, type, 0, 0, interlace], 8);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(Uint8Array.from(raw))), chunk('IEND', new Uint8Array())]);
}
afterEach(() => vi.unstubAllGlobals());
describe('native PNG and array workflows', () => {
  it.each([1, 3, 4] as const)('ports public uint8 %i-channel round trips without Canvas or WASM', async channels => {
    const data = Uint8Array.from({ length: 2 * 2 * channels }, (_, i) => i * 17);
    const image = { width: 2, height: 2, channels, data }, expected = imageArrayToRgba(image);
    const blob = await arrayToPng(image);
    for (const source of [blob, new Uint8Array(await blob.arrayBuffer()), blob.stream()]) expect(await pngToArray(source)).toEqual(expected);
    expect(await loadImage(blob)).toEqual(expected);
  });
  it('preserves hidden RGB, low alpha and subarray offsets exactly through all public PNG helpers', async () => {
    const backing = new Uint8Array(24); backing.set([12,34,56,0,78,90,123,1,45,67,89,128,210,220,230,64],4);
    const data = backing.subarray(4,20), expected = new Uint8ClampedArray(data);
    for (const compression of ['none', 'deflate'] as const) {
      const blob = await encodePng(2, 2, data, { compression });
      expect(decodePng(new Uint8Array(await blob.arrayBuffer())).data).toEqual(expected);
    }
    expect(await loadImage(await exportImage({ width:2,height:2,data:expected }))).toEqual({ width:2,height:2,data:expected });
    vi.stubGlobal('CompressionStream', undefined);
    expect((await pngToArray(await arrayToPng({width:2,height:2,channels:4,data}))).data).toEqual(expected);
  });
  it.each([0,1,2,3,4])('decodes PNG scanline filter %i', filter => {
    // Two grayscale rows, encoded manually for each PNG predictor.
    const rows = [[10,30,20],[40,60,80]], raw: number[] = [];
    for(let y=0;y<2;y++){raw.push(filter);for(let x=0;x<3;x++){
      const a=x?rows[y]![x-1]!:0,b=y?rows[y-1]![x]!:0,c=x&&y?rows[y-1]![x-1]!:0,p=a+b-c;
      const predictor=filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?(Math.abs(p-a)<=Math.abs(p-b)&&Math.abs(p-a)<=Math.abs(p-c)?a:Math.abs(p-b)<=Math.abs(p-c)?b:c):0;
      raw.push((rows[y]![x]!-predictor+256)%256);
    }}
    expect([...decodePng(png(3,2,8,0,raw)).data].filter((_,i)=>i%4===0)).toEqual(rows.flat());
  });
  it.each([1,2,4])('decodes packed grayscale and indexed transparency at depth %i', depth => {
    const mask=2**depth-1, bits=mask<<(8-depth*2);
    expect([...decodePng(png(2,1,depth,0,[0,bits])).data]).toEqual([0,0,0,255,255,255,255,255]);
    const palette=Buffer.alloc((mask+1)*3);palette.set([10,20,30]);palette.set([90,80,70],mask*3);
    const alpha=Buffer.alloc(mask+1,255);alpha[0]=0;alpha[mask]=64;
    expect([...decodePng(png(2,1,depth,3,[0,bits],[chunk('PLTE',palette),chunk('tRNS',alpha)])).data]).toEqual([10,20,30,0,90,80,70,64]);
  });
  it('decodes grayscale alpha, RGB tRNS, 16-bit channels and Adam7', () => {
    expect([...decodePng(png(1,1,8,4,[0,128,64])).data]).toEqual([128,128,128,64]);
    expect([...decodePng(png(1,1,16,6,[0,0xff,0xff,0x80,0x80,0,0,0x40,0x40])).data]).toEqual([255,128,0,64]);
    expect([...decodePng(png(1,1,8,2,[0,10,20,30],[chunk('tRNS',Buffer.from([0,10,0,20,0,30]))])).data]).toEqual([10,20,30,0]);
    // Adam7 3x3 grayscale: passes 1,4,5,6,7 each have known pixel ordering.
    const raw=[0,1, 0,3, 0,7,9, 0,2, 0,8, 0,4,5,6];
    expect([...decodePng(png(3,3,8,0,raw,[],1)).data].filter((_,i)=>i%4===0)).toEqual([1,2,3,4,5,6,7,8,9]);
  });
  it('fails closed on corrupt chunks, decompression bombs, dimensions and cancellation', async () => {
    const bytes=png(1,1,8,6,[0,1,2,3,4]),corrupt=bytes.slice();corrupt[corrupt.length-1]^=1;
    expect(()=>decodePng(corrupt)).toThrow('CRC'); expect(()=>decodePng(bytes.slice(0,-12))).toThrow('IEND');
    expect(()=>decodePng(png(1,1,8,6,new Array(200000).fill(0)))).toThrow('exceeds');
    expect(()=>decodePng(png(100000,100000,8,6,[0]))).toThrow('pixel limit');
    expect(()=>decodePng(png(1,1,8,6,[5,0,0,0,0]))).toThrow('filter');
    expect(()=>decodePng(png(1,1,8,6,[0,0,0]))).toThrow('truncated');
    expect(()=>imageArrayToRgba({width:2,height:1,channels:4,data:new Uint8Array(4)})).toThrow('uint8');
    expect(()=>imageArrayToRgba({width:1,height:1,channels:4,data:new Float32Array(4) as never})).toThrow('uint8');
    await expect(pngToArray(bytes,{signal:AbortSignal.abort()})).rejects.toMatchObject({code:'REQUEST_CANCELLED'});
    await expect(pngToArray(bytes,{maxBytes:1})).rejects.toThrow();
  });
  it('requires browser display APIs and copies array ownership', () => {
    const image={width:1,height:1,channels:4 as const,data:new Uint8Array([1,2,3,4])},rgba=imageArrayToRgba(image);rgba.data[0]=99;expect(image.data[0]).toBe(1);
    expect(()=>imageArrayToImageData(image)).toThrow('ImageData');
    vi.stubGlobal('ImageData',class { data:Uint8ClampedArray;width:number;height:number;constructor(d:Uint8ClampedArray,w:number,h:number){this.data=d;this.width=w;this.height=h;} });
    const putImageData=vi.fn(),canvas={width:0,height:0,getContext:()=>({putImageData})};
    displayImageArray(canvas as never,image);expect(putImageData).toHaveBeenCalledOnce();expect(canvas.width).toBe(1);
  });
});
