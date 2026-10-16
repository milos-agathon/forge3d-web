import { Frame, HdrFrame } from "./index.js";
import type { PathTracerOptions, TraceSceneInput, TraceRenderOptions, TraceProgress, TraceResult, TraceMemoryReport, TraceCamera, TraceTraversalMode } from "./trace-types.js";
export declare class PathTracer {
    #private;
    readonly width: number;
    readonly height: number;
    readonly backend: "webgpu" | "cpu";
    readonly engine: "megakernel" | "wavefront";
    readonly memoryBudgetBytes: number;
    private constructor();
    static create(options: PathTracerOptions, context?: {
        device?: GPUDevice;
    }): Promise<PathTracer>;
    get size(): readonly [number, number];
    get samples(): number;
    supportsGpu(): boolean;
    setScene(input: TraceSceneInput): Promise<void>;
    setCamera(camera: TraceCamera): Promise<void>;
    setTraversalMode(mode: TraceTraversalMode): void;
    reset(): void;
    enableSceneCache(enabled?: boolean, capacity?: number): void;
    resetSceneCache(): void;
    cacheStats(): {
        hits: number;
        misses: number;
        entries: number;
        bytes: number;
    };
    progressive(options?: TraceRenderOptions & {
        updateEvery?: number;
    }): AsyncGenerator<TraceProgress, void, unknown>;
    render(options?: TraceRenderOptions): Promise<TraceResult>;
    renderRgba(options?: TraceRenderOptions): Promise<Frame>;
    renderHdr(options?: TraceRenderOptions): Promise<HdrFrame>;
    recover(device?: GPUDevice): Promise<void>;
    memoryReport(): TraceMemoryReport;
    dispose(): void;
}
export declare const createPathTracer: typeof PathTracer.create;
