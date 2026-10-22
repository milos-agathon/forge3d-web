import { Forge3DError } from './runtime-failure.js';
type CaptureKind = 'screenshot' | 'rgba' | 'exclusive';
/** Owns capture exclusivity, offline leases, ordered mutations and final disposal. */
export class RuntimeOperations {
  #capture: {kind:CaptureKind;promise:Promise<unknown>} | undefined;
  #mutations: (()=>void)[]=[];
  #offline=false;
  #disposed=false;
  #finalized=false;
  constructor(readonly finalize:()=>void,readonly report:(error:Forge3DError)=>void){}
  get disposed(){return this.#disposed;}
  get offline(){return this.#offline;}
  get capturing(){return this.#capture!==undefined;}
  assertLive():void{if(this.#disposed)throw new Forge3DError('RUNTIME_DISPOSED','Runtime is disposed');}
  assertDisplay():void{if(this.#offline)throw new Forge3DError('INVALID_INPUT','An offline accumulation session is active; end it before reading the display frame');}
  async waitForCapture():Promise<void>{while(this.#capture){await this.#capture.promise.catch(()=>{});this.assertLive();}}
  async capture<T>(kind:CaptureKind,operation:()=>Promise<T>):Promise<T>{
    this.assertLive();if(kind!=='exclusive')this.assertDisplay();
    while(this.#capture){
      if(kind!=='exclusive'&&this.#capture.kind===kind)return this.#capture.promise as Promise<T>;
      await this.#capture.promise.catch(()=>{});this.assertLive();if(kind!=='exclusive')this.assertDisplay();
    }
    const result=operation().then(value=>{this.assertLive();return value;},error=>{this.assertLive();throw Forge3DError.from(error);});
    this.#capture={kind,promise:result};
    const complete=()=>{try{if(this.#capture?.promise!==result)return;this.#capture=undefined;if(this.#disposed)this.#finish();else if(!this.#offline)this.#flush();}catch(error){this.report(Forge3DError.from(error));}};
    void result.then(complete,complete);return result;
  }
  beginOffline(operation:()=>void):void{
    this.assertLive();
    if(this.#offline)throw new Forge3DError('INVALID_INPUT','An offline accumulation session is already active.');
    if(this.capturing)throw new Forge3DError('INVALID_INPUT','Cannot begin offline accumulation while a readback is in flight');
    try{operation();this.#offline=true;}catch(error){throw Forge3DError.from(error);}
  }
  endOffline(operation:()=>void):boolean{
    const active=this.#offline;this.#offline=false;
    if(!this.#finalized){try{operation();}catch(error){this.report(Forge3DError.from(error));}}
    if(active&&!this.capturing&&!this.#disposed)this.#flush();return active;
  }
  mutate(operation:()=>void):void{
    this.assertLive();if(this.capturing||this.#offline){this.#mutations.push(operation);return;}
    try{operation();}catch(error){throw Forge3DError.from(error);}
  }
  #flush():void{for(const mutation of this.#mutations.splice(0)){try{mutation();}catch(error){this.report(Forge3DError.from(error));}}}
  dispose():void{if(this.#disposed)return;this.#disposed=true;this.#mutations=[];if(!this.capturing)this.#finish();}
  #finish():void{if(this.#finalized)return;this.#finalized=true;this.finalize();}
}
