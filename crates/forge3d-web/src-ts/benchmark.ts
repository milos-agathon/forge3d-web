import { Forge3DError } from './index.js';
import type { Forge3DSessionCapabilities, RendererConfigSource, RendererConfigData, MemoryReport, RenderStats } from './index.js';
import { RendererConfig } from './renderer-config.js';
import { normalizeMemoryReport } from './native-reports.js';
import { arrayToPng } from './image-array.js';
import { decodePng } from './png-decode.js';

export const BENCHMARK_SCHEMA_VERSION = 1;
export type BenchmarkOperation = 'renderer_rgba' | 'renderer_png' | 'array_to_png' | 'png_to_array' | 'custom';
export interface BenchmarkTarget {
  getConfig(): RendererConfig;
  getCapabilities(): Forge3DSessionCapabilities;
  getMemoryReport(): MemoryReport;
  readRgba(): Promise<Uint8Array>;
  screenshot(): Promise<Blob>;
}
export interface BenchmarkBudget { maxP95Ms?: number; maxMemoryBytes?: number; }
export interface BenchmarkOptions {
  op: BenchmarkOperation;
  width: number; height: number;
  iterations?: number; warmup?: number; seed?: number;
  /** The target's actual W02 config is recorded for renderer operations. */
  target?: BenchmarkTarget;
  renderer?: RendererConfigSource;
  operation?: () => unknown | Promise<unknown>;
  memory?: () => MemoryReport;
  budget?: BenchmarkBudget;
  baseline?: BenchmarkResult;
  /** Allowed steady p95 increase over baseline; defaults to native perf_sanity's 50%. */
  maxRegressionPercent?: number;
  signal?: AbortSignal;
  /** Stops between operations; it cannot preempt a caller's pending Promise. */
  maxDurationMs?: number;
}
export interface BenchmarkStatistics {
  minMs: number; p50Ms: number; meanMs: number; p95Ms: number; maxMs: number; stdMs: number;
}
export interface BenchmarkEnvironment {
  userAgent: string | null; hardwareConcurrency: number | null;
  devicePixelRatio: number | null; crossOriginIsolated: boolean;
  secureContext: boolean; capabilities: Forge3DSessionCapabilities | null;
}
export interface BenchmarkResult {
  schemaVersion: 1; op: BenchmarkOperation; width: number; height: number; pixels: number;
  iterations: number; warmup: number; seed: number; coldMs: number; samplesMs: number[];
  timing: 'cpu-completion'; stats: BenchmarkStatistics;
  throughput: { fps: number; mpixPerSecond: number };
  renderer: RendererConfigData | null; environment: BenchmarkEnvironment;
  memory: { before: MemoryReport | null; after: MemoryReport | null; maxObservedBytes: number | null; deltaBytes: number | null };
  /** Unavailable: current W02 capture paths do not update session render statistics. */
  rendererStats: RenderStats | null;
  baseline: { p95Ms: number; maxRegressionPercent: number; limitMs: number; regressionPercent: number | null } | null;
  budget: { limits: BenchmarkBudget; passed: boolean; violations: string[] };
}
function invalid(message: string): never { throw new Forge3DError('INVALID_INPUT', message); }
function count(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be an integer in ${min}..${max}`);
  return value;
}
/** NumPy-compatible linear interpolation; population standard deviation. */
export function benchmarkStatistics(samples: readonly number[]): BenchmarkStatistics {
  if (!samples.length || samples.some(x => !Number.isFinite(x) || x < 0)) invalid('Benchmark samples must be finite nonnegative milliseconds');
  const sorted = [...samples].sort((a, b) => a - b), mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const percentile = (p: number): number => { const i = (sorted.length - 1) * p, lo = Math.floor(i); return sorted[lo]! + (sorted[Math.ceil(i)]! - sorted[lo]!) * (i - lo); };
  return { minMs: sorted[0]!, p50Ms: percentile(.5), meanMs: mean, p95Ms: percentile(.95), maxMs: sorted.at(-1)!, stdMs: Math.sqrt(samples.reduce((n, x) => n + (x - mean) ** 2, 0) / samples.length) };
}
export function benchmarkEnvironment(target?: BenchmarkTarget): BenchmarkEnvironment {
  return {
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    hardwareConcurrency: typeof navigator === 'undefined' ? null : navigator.hardwareConcurrency ?? null,
    devicePixelRatio: typeof devicePixelRatio === 'undefined' ? null : devicePixelRatio,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    secureContext: globalThis.isSecureContext === true,
    capabilities: target ? structuredClone(target.getCapabilities()) : null,
  };
}
/** Samples asynchronous operation completion, excludes warmup and setup, never creates a renderer preset or dataset catalog. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const width = count(options.width, 'width', 1, 16384), height = count(options.height, 'height', 1, 16384);
  if (width * height > 16_777_216) invalid('Benchmark pixel limit exceeded');
  const iterations = count(options.iterations ?? 100, 'iterations', 1, 100000), warmup = count(options.warmup ?? 10, 'warmup', 0, 100000), seed = count(options.seed ?? 0, 'seed', 0, 0xffffffff);
  const op = options.op, target = options.target, limits = { ...options.budget };
  if (!['renderer_rgba', 'renderer_png', 'array_to_png', 'png_to_array', 'custom'].includes(op)) invalid('Unknown benchmark operation');
  for (const [name, value] of Object.entries(limits)) if (!['maxP95Ms', 'maxMemoryBytes'].includes(name) || !Number.isFinite(value) || value < 0) invalid(`Invalid benchmark budget ${name}`);
  const maxDurationMs = options.maxDurationMs ?? 300000;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) invalid('maxDurationMs must be positive');
  const renderer = target ? target.getConfig().toJSON() : options.renderer === undefined ? null : RendererConfig.from(options.renderer).toJSON();
  const environment = benchmarkEnvironment(target), baseline = options.baseline;
  const maxRegressionPercent = options.maxRegressionPercent ?? 50;
  if (!Number.isFinite(maxRegressionPercent) || maxRegressionPercent < 0) invalid('maxRegressionPercent must be finite and nonnegative');
  if (baseline !== undefined && (!baseline || baseline.schemaVersion !== 1 || baseline.op !== op || baseline.width !== width || baseline.height !== height || baseline.seed !== seed || baseline.timing !== 'cpu-completion' || JSON.stringify(baseline.renderer) !== JSON.stringify(renderer) || !Number.isFinite(baseline.stats?.p95Ms) || baseline.stats.p95Ms < 0)) invalid('Benchmark baseline must match schema, operation, dimensions, seed, timing and renderer config');
  const readMemory = options.memory ?? (target ? () => target.getMemoryReport() : undefined);
  const memory = (): MemoryReport | null => {
    if (!readMemory) return null;
    const value = normalizeMemoryReport(readMemory());
    if (!value) invalid('Invalid W02 memory report');
    return structuredClone(value);
  };
  const start = performance.now();
  const check = (): void => {
    if (options.signal?.aborted) throw new Forge3DError('REQUEST_CANCELLED', 'Benchmark cancelled');
    if (performance.now() - start > maxDurationMs) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Benchmark duration exceeded');
  };
  check();
  let step: () => unknown | Promise<unknown>;
  if (op === 'custom') {
    if (typeof options.operation !== 'function') invalid('Custom benchmark requires operation');
    step = options.operation;
  } else if (op === 'array_to_png' || op === 'png_to_array') {
    const data = new Uint8Array(width * height * 4);
    let state = seed;
    for (let i = 0; i < data.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; data[i] = state >>> 24; }
    const image = { width, height, data, channels: 4 as const };
    if (op === 'array_to_png') step = () => arrayToPng(image);
    else { const bytes = new Uint8Array(await (await arrayToPng(image)).arrayBuffer()); step = () => decodePng(bytes); }
  } else {
    if (!target) invalid('Renderer benchmark requires a W02 session target');
    step = async () => {
      // W02 readback/screenshot already encode and await their own scene pass.
      if (op === 'renderer_png') {
        const blob = await target.screenshot();
        const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
        if (header.length !== 24 || ![137,80,78,71,13,10,26,10].every((v,i)=>header[i]===v)) invalid('Renderer returned an invalid PNG');
        const dimensions = new DataView(header.buffer);
        if (dimensions.getUint32(16) !== width || dimensions.getUint32(20) !== height) invalid('Renderer output dimensions differ from benchmark dimensions');
      } else {
        const rgba = await target.readRgba(); if (rgba.length !== width * height * 4) invalid('Renderer output dimensions differ from benchmark dimensions');
      }
    };
  }
  const before = memory(); let maxObservedBytes = before?.currentBytes ?? null;
  const observe = (): MemoryReport | null => { const value = memory(); if (value) maxObservedBytes = Math.max(maxObservedBytes ?? 0, value.currentBytes, value.peakBytes); return value; };
  check(); const coldStart = performance.now(); await step(); const coldMs = performance.now() - coldStart;
  if (!Number.isFinite(coldMs) || coldMs < 0) invalid('Cold timing must be finite nonnegative milliseconds');
  check(); observe();
  for (let i = 0; i < warmup; i++) { check(); await step(); check(); observe(); }
  const samplesMs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    check(); const t0 = performance.now(); await step(); const elapsed = performance.now() - t0;
    check(); samplesMs.push(elapsed); observe();
  }
  const after = observe(), stats = benchmarkStatistics(samplesMs), fps = stats.meanMs > 0 ? 1000 / stats.meanMs : 0, violations: string[] = [];
  if (limits.maxP95Ms !== undefined && stats.p95Ms > limits.maxP95Ms) violations.push('maxP95Ms');
  if (limits.maxMemoryBytes !== undefined && (maxObservedBytes === null || maxObservedBytes > limits.maxMemoryBytes)) violations.push(maxObservedBytes === null ? 'memoryUnavailable' : 'maxMemoryBytes');
  const comparison = baseline === undefined ? null : {
    p95Ms: baseline.stats.p95Ms, maxRegressionPercent,
    limitMs: baseline.stats.p95Ms * (1 + maxRegressionPercent / 100),
    regressionPercent: baseline.stats.p95Ms > 0 ? (stats.p95Ms / baseline.stats.p95Ms - 1) * 100 : stats.p95Ms === 0 ? 0 : null,
  };
  if (comparison && stats.p95Ms > comparison.limitMs) violations.push('baselineP95Regression');
  return {
    schemaVersion: 1, op, width, height, pixels: width * height, iterations, warmup, seed, coldMs, samplesMs, timing: 'cpu-completion', stats,
    throughput: { fps, mpixPerSecond: width * height / 1e6 * fps }, renderer, environment,
    memory: { before, after, maxObservedBytes, deltaBytes: before && after ? after.currentBytes - before.currentBytes : null },
    rendererStats: null, baseline: comparison,
    budget: { limits, passed: violations.length === 0, violations },
  };
}
export async function runBenchmarkSuite(operations: readonly BenchmarkOptions[]): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const operation of operations) results.push(await runBenchmark(operation));
  return results;
}
