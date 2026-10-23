import {Forge3DError} from './runtime-failure.js';
export interface DecodeParameters {
  tileWidth: number;
  tileHeight: number;
  planarConfiguration: number;
  bitsPerSample: number[];
  predictor: number;
  samplesPerPixel: number;
  jpegTables?: ArrayBuffer | Uint8Array;
}

export class TiffSampleLayout {
 readonly bits:number[];readonly formats:number[];readonly offsets:number[];readonly pixelBytes:number;
 constructor(readonly parameters:DecodeParameters,formats:readonly number[]){
  const p=parameters,n=p.samplesPerPixel;
  const invalid=()=>{throw new Forge3DError('UNSUPPORTED_FEATURE','Unsupported TIFF sample layout',{reason:'cog-sample-layout'});};
  if(!Number.isInteger(n)||n<1||n>64||![1,2].includes(p.planarConfiguration)||!Number.isSafeInteger(p.tileWidth*p.tileHeight)||p.tileWidth<1||p.tileHeight<1)invalid();
  const expand=(values:readonly number[])=>{if(values.length!==1&&values.length!==n)invalid();return Array.from({length:n},(_,i)=>values.length===1?values[0]!:values[i]!);};
  this.bits=expand(p.bitsPerSample);this.formats=expand(formats);this.offsets=[];let bytes=0;
  for(let i=0;i<n;i++){const bits=this.bits[i]!,format=this.formats[i]!;if(![1,2,3].includes(format)||!(format===3?[16,32,64]:[8,16,32]).includes(bits))invalid();this.offsets.push(bytes);bytes+=bits/8;}this.pixelBytes=bytes;
 }
 requireRgba():void{
  if(this.bits.some(b=>b!==8)||this.formats.some(f=>f!==1))throw new Forge3DError('UNSUPPORTED_FEATURE',`COG RGBA read requires uint8 samples (bits ${this.bits[0]}, sampleFormat ${this.formats[0]})`,{reason:'cog-rgba-format'});
  if(![1,3,4].includes(this.parameters.samplesPerPixel))throw new Forge3DError('UNSUPPORTED_FEATURE',`COG RGBA read supports 1/3/4 samples, got ${this.parameters.samplesPerPixel}`,{reason:'cog-rgba-samples'});
 }
 tileIndex(x:number,y:number,sample:number,across:number,down:number):number{return x+y*across+(this.parameters.planarConfiguration===2?sample*across*down:0);}
 numeric(decoded:ArrayBuffer,band:number,littleEndian:boolean,validHeight=this.parameters.tileHeight):Float32Array{return tileToFloat32(decoded,this,band,littleEndian,validHeight);}
}
/** Convert one decoded tile buffer to `tileWidth*tileHeight` float32
 * samples of `band` (0-based), handling sample formats 1-3, bit
 * depths 8-64 and the file's endianness. */
function tileToFloat32(
  decoded: ArrayBuffer,
  descriptor:TiffSampleLayout,
  band: number,
  littleEndian: boolean,
  validHeight = descriptor.parameters.tileHeight,
): Float32Array {
  const { tileWidth, tileHeight, planarConfiguration } = descriptor.parameters;
  if(!Number.isInteger(band)||band<0||band>=descriptor.bits.length||!Number.isInteger(validHeight)||validHeight<0||validHeight>tileHeight)throw new Forge3DError("INVALID_INPUT","Invalid TIFF band or decoded height");

  const bytesPerSample = descriptor.bits[band]! >> 3;
  const stride =
    planarConfiguration === 1 ? descriptor.pixelBytes : bytesPerSample;
  const base = planarConfiguration === 1 ? descriptor.offsets[band]! : 0;
  const view = new DataView(decoded);
  const format = descriptor.formats[band]!;
  const bits = descriptor.bits[band]!;
  let read: (offset: number) => number;
  if (format === 3) {
    if (bits === 16) {
      read = (offset) => float16BitsToNumber(view.getUint16(offset, littleEndian));
    } else {
      read =
        bits === 64
          ? (offset) => view.getFloat64(offset, littleEndian)
          : (offset) => view.getFloat32(offset, littleEndian);
    }
  } else {
    switch (bits) {
      case 8:
        read =
          format === 2
            ? (offset) => view.getInt8(offset)
            : (offset) => view.getUint8(offset);
        break;
      case 16:
        read =
          format === 2
            ? (offset) => view.getInt16(offset, littleEndian)
            : (offset) => view.getUint16(offset, littleEndian);
        break;
      default:
        read =
          format === 2
            ? (offset) => view.getInt32(offset, littleEndian)
            : (offset) => view.getUint32(offset, littleEndian);
    }
  }
  const validPixels = tileWidth * validHeight;
  if (decoded.byteLength < validPixels * stride) {
    throw new Forge3DError("IO_ERROR", "TIFF sample data is truncated", { reason: "cog-truncated-samples" });
  }
  const out = new Float32Array(tileWidth * tileHeight);
  for (let index = 0; index < validPixels; index += 1) {
    out[index] = read(base + index * stride);
  }
  return out;
}

/** IEEE-754 half → f32 decode (sampleFormat 3 + 16-bit). */
function float16BitsToNumber(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
