import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePng } from '../../src-ts/frames.js';
import { runBenchmark } from '../../src-ts/benchmark.js';
import { RendererConfig } from '../../src-ts/renderer-config.js';
import { SceneMemoryTracker } from '../../src-ts/memory-policy.js';
afterEach(() => vi.unstubAllGlobals());

describe('W21 benchmark review regressions', () => {
  it('times one cold operation, excludes it and warmups from steady samples, and reports no invented renderer', async () => {
    let clock = 0, calls = 0; vi.stubGlobal('performance', { now: () => clock });
    const report: any = await runBenchmark({ op: 'custom', width: 1, height: 1, warmup: 2, iterations: 3, operation: async () => { clock += [100, 20, 30, 2, 4, 6][calls++]!; } });
    expect(report.coldMs).toBe(100); expect(report.samplesMs).toEqual([2, 4, 6]); expect(calls).toBe(6); expect(report.renderer).toBeNull();
  });
  it.each(['renderer_rgba','renderer_png'] as const)('%s captures once per operation and marks stale session statistics unavailable', async op => {
    const render = vi.fn(() => true), readRgba = vi.fn(async () => new Uint8Array(4));
    const png=await encodePng(1,1,new Uint8Array(4),{compression:'none'}),screenshot=vi.fn(async()=>png);
    const getRenderStats = vi.fn(() => ({ frameIndex: 123, frameTimeMs: 900, drawCalls: 2, triangles: 100, passes: [] }));
    const target = { render, readRgba, screenshot, getConfig: () => new RendererConfig({ quality: 'low' }), getCapabilities: () => ({} as never), getMemoryReport: () => new SceneMemoryTracker(1024).report(), getRenderStats };
    const report = await runBenchmark({ op, width: 1, height: 1, target, iterations: 2, warmup: 1 });
    expect(render).not.toHaveBeenCalled(); expect(op==='renderer_rgba'?readRgba:screenshot).toHaveBeenCalledTimes(4); expect(op==='renderer_rgba'?screenshot:readRgba).not.toHaveBeenCalled(); expect(report.rendererStats).toBeNull(); expect(report.renderer?.quality).toBe('low');
    await expect(runBenchmark({ op: 'scene_rgba' as never, width: 1, height: 1, target })).rejects.toThrow('Unknown');
  });
  it('compares steady p95 against a matching prior report with a default 50% tolerance', async () => {
    let clock = 0; vi.stubGlobal('performance', { now: () => clock });
    const run = (ms: number, extra: object = {}) => runBenchmark({ op: 'custom', width: 1, height: 1, warmup: 0, iterations: 2, operation: () => { clock += ms; }, ...extra });
    const baseline = await run(10);
    const equal: any = await run(15, { baseline }); expect(equal.budget.passed).toBe(true); expect(equal.baseline.maxRegressionPercent).toBe(50);
    const regressed: any = await run(16, { baseline }); expect(regressed.budget.violations).toContain('baselineP95Regression'); expect(regressed.baseline.regressionPercent).toBeCloseTo(60);
    const strict: any = await run(11, { baseline, maxRegressionPercent: 0 }); expect(strict.budget.violations).toContain('baselineP95Regression');
    await expect(run(10, { baseline: { ...baseline, width: 2 } })).rejects.toThrow('baseline');
  });
});

it('handles a zero baseline without serializing Infinity or accepting incompatible options',async()=>{
  let clock=0;vi.stubGlobal('performance',{now:()=>clock});
  const options={op:'custom' as const,width:1,height:1,warmup:0,iterations:1,operation:()=>{}};
  const baseline=await runBenchmark(options);
  const report=await runBenchmark({...options,baseline,operation:()=>{clock++;}});
  expect(report.baseline?.regressionPercent).toBeNull();expect(report.budget.violations).toContain('baselineP95Regression');
  expect(JSON.stringify(report)).not.toMatch(/Infinity|NaN/);
  for(const maxRegressionPercent of [-1,NaN,Infinity])await expect(runBenchmark({...options,baseline,maxRegressionPercent})).rejects.toThrow('maxRegressionPercent');
});
