import { Forge3DError } from './runtime-failure.js';
/** Owns only this submission's scope, mappings and allocations until drain. */
export class TraceGpuWork {
  readonly #buffers = new Set<GPUBuffer>();
  readonly #mapped = new Set<GPUBuffer>();
  #scope = true;
  #submitted = false;
  #closed: Promise<void> | undefined;
  constructor(readonly device: GPUDevice, private ownsDevice = false) { device.pushErrorScope('validation'); }
  buffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    const buffer=this.device.createBuffer(descriptor);this.#buffers.add(buffer);return buffer;
  }
  submit(commands: GPUCommandBuffer[]): void { this.device.queue.submit(commands);this.#submitted=true; }
  async read(buffer: GPUBuffer): Promise<ArrayBuffer> {
    await buffer.mapAsync(1);this.#mapped.add(buffer);
    try { return buffer.getMappedRange().slice(0); }
    finally { buffer.unmap();this.#mapped.delete(buffer); }
  }
  async validate(): Promise<void> {
    if(!this.#scope)return;
    this.#scope=false; // pop consumes the scope even if its promise rejects.
    const error=await this.device.popErrorScope();
    if(error)throw new Forge3DError('SHADER_COMPILATION_FAILED',error.message);
  }
  transfer(): void { this.#buffers.clear();this.ownsDevice=false; }
  close(): Promise<void> {
    return this.#closed ??= (async()=>{
      try {
        if(this.#submitted)await this.device.queue.onSubmittedWorkDone().catch(()=>{});
        if(this.#scope){this.#scope=false;await this.device.popErrorScope().catch(()=>null);}
      } finally {
        for(const buffer of this.#mapped)buffer.unmap();this.#mapped.clear();
        for(const buffer of this.#buffers)buffer.destroy();this.#buffers.clear();
        if(this.ownsDevice)this.device.destroy();
      }
    })();
  }
}
