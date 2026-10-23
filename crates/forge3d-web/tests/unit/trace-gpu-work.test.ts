import { expect,it,vi } from 'vitest';
import { TraceGpuWork } from '../../src-ts/trace-gpu-work.js';
it.each(['compile','map','validation'])('balances scope and buffers on %s failure',async stage=>{
 const destroy=vi.fn(),unmap=vi.fn();const buffer={destroy,unmap,mapAsync:vi.fn(async()=>{if(stage==='map')throw Error('map');}),getMappedRange:()=>new ArrayBuffer(4)} as unknown as GPUBuffer;
 const device={createBuffer:()=>buffer,pushErrorScope:vi.fn(),popErrorScope:vi.fn(async()=>stage==='validation'?{message:'validation'}:null),destroy:vi.fn(),queue:{submit:vi.fn(),onSubmittedWorkDone:vi.fn(async()=>{})}} as unknown as GPUDevice;
 const work=new TraceGpuWork(device),b=work.buffer({size:4,usage:1});
 await expect((async()=>{try{if(stage==='compile')throw Error('compile');work.submit([]);await work.read(b);await work.validate();}finally{await work.close();}})()).rejects.toThrow(stage);
 await work.close();expect(device.pushErrorScope).toHaveBeenCalledTimes(1);expect(device.popErrorScope).toHaveBeenCalledTimes(1);expect(destroy).toHaveBeenCalledTimes(1);expect(device.destroy).not.toHaveBeenCalled();
});
it('holds allocations and an owned device until submitted work drains',async()=>{
 let drain!:()=>void;const done=new Promise<void>(r=>{drain=r;});const destroy=vi.fn();
 const device={createBuffer:()=>({destroy}),pushErrorScope:vi.fn(),popErrorScope:vi.fn(async()=>null),destroy:vi.fn(),queue:{submit:vi.fn(),onSubmittedWorkDone:()=>done}} as unknown as GPUDevice;
 const work=new TraceGpuWork(device,true);work.buffer({size:4,usage:1});work.submit([]);const closed=work.close();await Promise.resolve();expect(destroy).not.toHaveBeenCalled();drain();await closed;expect(destroy).toHaveBeenCalledTimes(1);expect(device.destroy).toHaveBeenCalledTimes(1);
});
