import { afterEach, describe, expect, it, vi } from 'vitest';
import { benchmarkStatistics, runBenchmark, runBenchmarkSuite } from '../../src-ts/benchmark.js';
import { RendererConfig } from '../../src-ts/renderer-config.js';
import { SceneMemoryTracker } from '../../src-ts/memory-policy.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import contract from '../fixtures/w21/native-contract.json';

afterEach(() => vi.unstubAllGlobals());
describe('native benchmark workflows and W02 reports', () => {
  it('uses NumPy linear percentiles and population standard deviation', () => {
    expect(benchmarkStatistics([6,2,4])).toEqual({minMs:2,p50Ms:4,meanMs:4,p95Ms:5.8,maxMs:6,stdMs:Math.sqrt(8/3)});
    expect(benchmarkStatistics([0])).toEqual({minMs:0,p50Ms:0,meanMs:0,p95Ms:0,maxMs:0,stdMs:0});
    expect(()=>benchmarkStatistics([])).toThrow();expect(()=>benchmarkStatistics([NaN])).toThrow();
  });
  it('awaits each operation, excludes warmup, records samples/config/environment/memory and checks budgets', async () => {
    let clock=0,calls=0;vi.stubGlobal('performance',{now:()=>clock});
    const tracker=new SceneMemoryTracker(4096);
    const result=await runBenchmark({op:'custom',width:10,height:10,warmup:2,iterations:3,renderer:new RendererConfig({quality:'low'}),
      operation:async()=>{await Promise.resolve();clock+=calls++<2?100:2*(calls-2);},memory:()=>tracker.report(),budget:{maxP95Ms:5,maxMemoryBytes:100}});
    expect(Object.keys(result).sort()).toEqual(['schemaVersion','op','width','height','pixels','iterations','warmup','seed','samplesMs','timing','stats','throughput','renderer','environment','memory','rendererStats','budget'].sort());
    expect(calls).toBe(5);expect(result.samplesMs).toEqual([2,4,6]);expect(result.stats.p50Ms).toBe(4);
    expect(result.throughput.fps).toBe(250);expect(result.throughput.mpixPerSecond).toBe(.025);
    expect(result.renderer.quality).toBe('low');expect(result.environment.capabilities).toBeNull();
    expect(result.memory).toMatchObject({maxObservedBytes:0,deltaBytes:0});expect(result.budget).toMatchObject({passed:false,violations:['maxP95Ms']});
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('records unavailable memory explicitly and never passes an unmeasurable memory budget', async () => {
    const result=await runBenchmark({op:'custom',width:1,height:1,warmup:0,iterations:1,operation:()=>{},budget:{maxMemoryBytes:1}});
    expect(result.memory.maxObservedBytes).toBeNull();expect(result.budget).toMatchObject({passed:false,violations:['memoryUnavailable']});
  });
  it('samples actual W02 memory peaks and validates source reports', async () => {
    const tracker=new SceneMemoryTracker(4096);
    const result=await runBenchmark({op:'custom',width:1,height:1,warmup:0,iterations:2,operation:()=>{if(!tracker.report().currentBytes)tracker.allocate('work','buffers',1024,'ultra','reject');},memory:()=>tracker.report(),budget:{maxMemoryBytes:512}});
    expect(result.memory).toMatchObject({maxObservedBytes:1024,deltaBytes:1024});expect(result.budget.violations).toEqual(['maxMemoryBytes']);
    await expect(runBenchmark({op:'custom',width:1,height:1,operation:()=>{},memory:()=>({} as never)})).rejects.toThrow('memory report');
  });
  it('fences renderer operations on readback and consumes the actual target config', async () => {
    let clock=0,readbacks=0;vi.stubGlobal('performance',{now:()=>clock});
    const target={render:()=>{clock+=1;return true;},readRgba:async()=>{await Promise.resolve();clock+=4;readbacks++;return new Uint8Array(16);},screenshot:async()=>new Blob(['png']),getConfig:()=>new RendererConfig({quality:'medium'}),getCapabilities:()=>({timingMode:'gpu-timestamp'} as never),getMemoryReport:()=>new SceneMemoryTracker(4096).report(),getRenderStats:()=>({frameIndex:1,frameTimeMs:1,drawCalls:1,triangles:1,passes:[]})};
    const result=await runBenchmark({op:'scene_rgba',width:2,height:2,warmup:1,iterations:2,target});
    expect(readbacks).toBe(3);expect(result.samplesMs).toEqual([5,5]);expect(result.renderer.quality).toBe('medium');expect(result.timing).toBe('cpu-completion');
    await expect(runBenchmark({op:'renderer_rgba',width:1,height:1,warmup:0,iterations:1,target})).rejects.toThrow('dimensions');
  });
  it('runs seeded encode/decode operation suites without rendering, Python or network', async () => {
    const results=await runBenchmarkSuite(['array_to_png','png_to_array'].map(op=>({op:op as 'array_to_png'|'png_to_array',width:4,height:3,iterations:2,warmup:1,seed:42})));
    expect(results.map(r=>r.schemaVersion)).toEqual([1,1]);for(const r of results){expect(r.samplesMs).toHaveLength(2);expect(r.pixels).toBe(12);expect(r.budget.passed).toBe(true);}
  });
  it('rejects invalid requests, cancellation, operation failures and elapsed duration', async () => {
    const base={op:'custom' as const,width:1,height:1,operation:()=>{}};
    for(const invalid of [{iterations:0},{warmup:-1},{width:NaN},{seed:1.5},{maxDurationMs:0},{budget:{maxP95Ms:NaN}}]) await expect(runBenchmark({...base,...invalid})).rejects.toThrow();
    await expect(runBenchmark({...base,signal:AbortSignal.abort()})).rejects.toMatchObject({code:'REQUEST_CANCELLED'});
    await expect(runBenchmark({...base,operation:()=>{throw Error('operation failed');}})).rejects.toThrow('operation failed');
    let clock=0;vi.stubGlobal('performance',{now:()=>clock});
    await expect(runBenchmark({...base,maxDurationMs:5,operation:()=>{clock+=6;}})).rejects.toThrow('duration');
  });
  it('pins the inspected native licensing, PNG and benchmark contracts', () => {
    for(const file of contract.files){const bytes=readFileSync(new URL('../fixtures/w21/native/'+file.path,import.meta.url));expect(createHash('sha256').update(bytes).digest('hex'),file.path).toBe(file.sha256);}
  });
});
