import type { Forge3DSessionCapabilities, RendererConfigSource, RendererConfigData, MemoryReport, RenderStats } from './index.js';
import { RendererConfig } from './index.js';
export declare const BENCHMARK_SCHEMA_VERSION = 1;
export type BenchmarkOperation = 'renderer_rgba' | 'renderer_png' | 'scene_rgba' | 'array_to_png' | 'png_to_array' | 'custom';
export interface BenchmarkTarget {
    getConfig(): RendererConfig;
    getCapabilities(): Forge3DSessionCapabilities;
    getMemoryReport(): MemoryReport;
    getRenderStats(): RenderStats;
    render(): boolean;
    readRgba(): Promise<Uint8Array>;
    screenshot(): Promise<Blob>;
}
export interface BenchmarkBudget {
    maxP95Ms?: number;
    maxMemoryBytes?: number;
}
export interface BenchmarkOptions {
    op: BenchmarkOperation;
    width: number;
    height: number;
    iterations?: number;
    warmup?: number;
    seed?: number;
    /** The target's actual W02 config is recorded for renderer operations. */
    target?: BenchmarkTarget;
    renderer?: RendererConfigSource;
    operation?: () => unknown | Promise<unknown>;
    memory?: () => MemoryReport;
    budget?: BenchmarkBudget;
    signal?: AbortSignal;
    /** Stops between operations; it cannot preempt a caller's pending Promise. */
    maxDurationMs?: number;
}
export interface BenchmarkStatistics {
    minMs: number;
    p50Ms: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
    stdMs: number;
}
export interface BenchmarkEnvironment {
    userAgent: string | null;
    hardwareConcurrency: number | null;
    devicePixelRatio: number | null;
    crossOriginIsolated: boolean;
    secureContext: boolean;
    capabilities: Forge3DSessionCapabilities | null;
}
export interface BenchmarkResult {
    schemaVersion: 1;
    op: BenchmarkOperation;
    width: number;
    height: number;
    pixels: number;
    iterations: number;
    warmup: number;
    seed: number;
    samplesMs: number[];
    timing: 'cpu-completion';
    stats: BenchmarkStatistics;
    throughput: {
        fps: number;
        mpixPerSecond: number;
    };
    renderer: RendererConfigData;
    environment: BenchmarkEnvironment;
    memory: {
        before: MemoryReport | null;
        after: MemoryReport | null;
        maxObservedBytes: number | null;
        deltaBytes: number | null;
    };
    rendererStats: RenderStats | null;
    budget: {
        limits: BenchmarkBudget;
        passed: boolean;
        violations: string[];
    };
}
/** NumPy-compatible linear interpolation; population standard deviation. */
export declare function benchmarkStatistics(samples: readonly number[]): BenchmarkStatistics;
export declare function benchmarkEnvironment(target?: BenchmarkTarget): BenchmarkEnvironment;
/** Samples asynchronous operation completion, excludes warmup and setup, never creates a renderer preset or dataset catalog. */
export declare function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult>;
export declare function runBenchmarkSuite(operations: readonly BenchmarkOptions[]): Promise<BenchmarkResult[]>;
