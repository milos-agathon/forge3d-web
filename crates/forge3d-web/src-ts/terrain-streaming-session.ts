import { Forge3DError } from './runtime-failure.js';
import { MemoryByteCache } from './byte-cache.js';
import type { HeightTileId, HeightTileSource } from './index.js';
type Request=HeightTileId & {priority:number};
type Ready=Request & {heights:Float32Array};
interface Fetch {controller:AbortController;settled:Promise<void>;detach:()=>void;}
const key=(id:HeightTileId)=>`${id.lod}/${id.x}/${id.y}`;
/** Owns request tokens, listeners, ready uploads and recovery bytes until disposal. */
export class TerrainStreamingSession {
    #inflight=new Map<string,Fetch>();
    #ready:Ready[]=[];
    #cache:MemoryByteCache;
    #lifetime=new AbortController();
    #listeners:(()=>void)[]=[];
    constructor(budget:number,private readonly signal:AbortSignal|undefined){this.#cache=new MemoryByteCache(budget);}
    get pendingCount(){return this.#inflight.size;}
    get readyCount(){return this.#ready.length;}
    listen(detach:()=>void):void{this.#listeners.push(detach);}
    next():Ready|undefined{return this.#ready.shift();}
    retain(tile:Ready):void{this.#cache.put(key(tile),new Uint8Array(tile.heights.buffer,tile.heights.byteOffset,tile.heights.byteLength));}
    evict(tile:HeightTileId):void{this.#cache.delete(key(tile));}
    cancel(tile:HeightTileId):void{
        const id=key(tile),entry=this.#inflight.get(id);
        if(entry){this.#inflight.delete(id);entry.detach();entry.controller.abort();}
        this.#ready=this.#ready.filter(t=>key(t)!==id);
    }
    request(request:Request,source:HeightTileSource,limit:number,fail:()=>void,report:(error:unknown)=>void):boolean {
        const id=key(request);if(this.#lifetime.signal.aborted||this.#inflight.has(id))return true;
        const cached=this.#cache.get(id);
        if(cached){this.#ready.push({...request,heights:new Float32Array(cached.buffer.slice(cached.byteOffset,cached.byteOffset+cached.byteLength) as ArrayBuffer)});return true;}
        if(this.#inflight.size>=limit)return false;
        const controller=new AbortController(),forward=()=>controller.abort();
        this.signal?.addEventListener('abort',forward,{once:true});
        const entry:Fetch={controller,settled:Promise.resolve(),detach:()=>this.signal?.removeEventListener('abort',forward)};
        const settle=()=>{if(this.#inflight.get(id)!==entry)return false;this.#inflight.delete(id);entry.detach();return !this.#lifetime.signal.aborted;};
        this.#inflight.set(id,entry);
        entry.settled=Promise.resolve().then(()=>source.readTile(request.lod,request.x,request.y,{signal:controller.signal,priority:request.priority})).then(heights=>{
            if(!settle())return;if(controller.signal.aborted){fail();return;}this.#ready.push({...request,heights});
        }).catch(error=>{if(!settle())return;fail();if(!controller.signal.aborted)report(error);});
        if(this.signal?.aborted)controller.abort();
        return true;
    }
    async wait(signal?:AbortSignal):Promise<void>{
        const signals=[this.#lifetime.signal,this.signal,signal].filter((s):s is AbortSignal=>!!s);
        for(const s of signals)s.throwIfAborted();
        const pending=[...this.#inflight.values()].map(entry=>entry.settled);
        if(!pending.length){await Promise.resolve();return;}
        let reject!:(reason:unknown)=>void;
        const cancelled=new Promise<never>((_,r)=>reject=r);
        const listeners=signals.map(s=>{const abort=()=>reject(s.reason);s.addEventListener('abort',abort,{once:true});if(s.aborted)abort();return()=>s.removeEventListener('abort',abort);});
        try{await Promise.race([...pending,cancelled]);}finally{for(const detach of listeners)detach();}
    }
    dispose():void{
        if(this.#lifetime.signal.aborted)return;
        this.#lifetime.abort(new Forge3DError('RUNTIME_DISPOSED','TerrainStreamer is disposed'));
        for(const detach of this.#listeners.splice(0))detach();
        for(const entry of this.#inflight.values()){entry.detach();entry.controller.abort();}
        this.#inflight.clear();this.#ready=[];this.#cache.clear();
    }
}
