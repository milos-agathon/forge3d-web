import { Forge3DError } from './runtime-failure.js';
interface RasterLevel {
    width:number; height:number; tileWidth:number; tileHeight:number;
    padded:boolean; maxBytes?:number;
    readTile:(x:number,y:number,signal?:AbortSignal)=>Promise<Float32Array>;
}
/** One output plus at most one decoded tile; accepts padded COG or clipped source tiles. */
export async function assembleRasterLevel(level:RasterLevel,signal?:AbortSignal):Promise<Float32Array> {
    signal?.throwIfAborted();
    const {width,height,tileWidth,tileHeight}=level;
    if(![width,height,tileWidth,tileHeight].every(n=>Number.isSafeInteger(n)&&n>0))throw new Forge3DError('INVALID_INPUT','Invalid raster level dimensions');
    const bytes=width*height*4;
    if(!Number.isSafeInteger(bytes)||bytes>(level.maxBytes??Number.MAX_SAFE_INTEGER))throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED','Raster level exceeds byte limit');
    const output=new Float32Array(width*height);
    for(let y=0;y<Math.ceil(height/tileHeight);y++)for(let x=0;x<Math.ceil(width/tileWidth);x++) {
        signal?.throwIfAborted(); const tile=await level.readTile(x,y,signal); signal?.throwIfAborted();
        const w=Math.min(tileWidth,width-x*tileWidth), h=Math.min(tileHeight,height-y*tileHeight), stride=level.padded?tileWidth:w;
        const expected=level.padded?tileWidth*tileHeight:w*h;
        if(!(tile instanceof Float32Array)||tile.length!==expected)throw new Forge3DError('INVALID_INPUT','Raster tile shape does not match its level',{x,y,expected,actual:tile?.length});
        for(let row=0;row<h;row++)output.set(tile.subarray(row*stride,row*stride+w),(y*tileHeight+row)*width+x*tileWidth);
    }
    return output;
}
/** Subscribers cancel independently. Failed/all-cancelled reads never poison a later attempt. */
export class SharedRasterLevel {
    #value:Float32Array|undefined;
    #pending:{controller:AbortController;promise:Promise<Float32Array>;users:number}|undefined;
    constructor(private readonly read:(signal:AbortSignal)=>Promise<Float32Array>){}
    get(signal?:AbortSignal):Promise<Float32Array> {
        if(signal?.aborted)return Promise.reject(signal.reason);
        if(this.#value)return Promise.resolve(this.#value);
        let pending=this.#pending;
        if(!pending){
            const controller=new AbortController();
            pending={controller,promise:Promise.resolve().then(()=>this.read(controller.signal)),users:0};
            this.#pending=pending;const owned=pending;
            pending.promise=pending.promise.then(value=>{if(this.#pending===owned&&!controller.signal.aborted)this.#value=value;return value;}).finally(()=>{if(this.#pending===owned)this.#pending=undefined;});
        }
        const owned=pending;owned.users++;
        let abort!:()=>void;
        return new Promise<Float32Array>((resolve,reject)=>{
            abort=()=>reject(signal?.reason);
            signal?.addEventListener('abort',abort,{once:true});
            owned.promise.then(resolve,reject);
            if(signal?.aborted)abort();
        }).finally(()=>{
            signal?.removeEventListener('abort',abort);
            owned.users--;
            if(!owned.users&&this.#pending===owned){this.#pending=undefined;owned.controller.abort();}
        });
    }
}
