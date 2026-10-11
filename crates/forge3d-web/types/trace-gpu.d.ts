import { TraceScene } from "./trace-scene.js";
import type { CpuTraceSettings } from "./trace-cpu.js";
export declare function packTraceScene(scene: TraceScene, guiding?: Float32Array): {
    bytes: ArrayBuffer;
    offsets0: number[];
    offsets1: number[];
    counts: number[];
};
export declare function traceUniform(scene: TraceScene, s: CpuTraceSettings, packed: ReturnType<typeof packTraceScene>, sample: number): ArrayBuffer;
export declare function requestTraceDevice(minStorageBytes?: number): Promise<GPUDevice>;
export declare class TraceGpu {
    #private;
    readonly device: GPUDevice;
    readonly source: TraceScene;
    readonly settings: CpuTraceSettings;
    readonly budget: number;
    readonly ownsDevice: boolean;
    readonly packed: ReturnType<typeof packTraceScene>;
    readonly bytes: number;
    private constructor();
    static create(device: GPUDevice, scene: TraceScene, settings: CpuTraceSettings, budget: number, ownsDevice?: boolean, engine?: "megakernel" | "wavefront"): Promise<TraceGpu>;
    checkAlive(): void;
    exportReservoirs(): Promise<ArrayBuffer>;
    restore(sum: Float32Array, reservoirs: ArrayBuffer): void;
    reset(): void;
    sample(sample: number, engine: "megakernel" | "wavefront", signal?: AbortSignal): Promise<Float32Array>;
    dispose(): void;
}
