import { PointCloudLayer } from "./pointcloud-layer.js";
import type { PointView, PointVec3 } from "./pointcloud-types.js";
export interface PointRendererOptions {
    memoryBudgetBytes?: number;
    clearColor?: readonly [number, number, number, number];
    powerPreference?: "low-power" | "high-performance";
    onDeviceLost?: (reason: string) => void;
}
export interface PointPickResult {
    id: number;
    layerName: string;
    nodeKey: string;
    pointIndex: number;
    position: PointVec3;
    color: readonly number[];
}
/** Instanced billboards: 32 bytes/point, six generated vertices, depth-aligned integer picking. */
export declare class PointCloudRenderer {
    #private;
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly options: PointRendererOptions;
    readonly memoryBudgetBytes: number;
    private constructor();
    static create(canvas: HTMLCanvasElement | OffscreenCanvas, options?: PointRendererOptions): Promise<PointCloudRenderer>;
    resize(width: number, height: number): void;
    setLayers(layers: readonly PointCloudLayer[]): void;
    render(view: PointView, signal?: AbortSignal): Promise<void>;
    readRgba(signal?: AbortSignal): Promise<Uint8Array>;
    pick(x: number, y: number, signal?: AbortSignal): Promise<PointPickResult | null>;
    /** Recreates device resources and replays retained CPU layers without dataset IO. */
    recover(): Promise<void>;
    getStats(): {
        frames: number;
        pointsRendered: number;
        gpuBytes: number;
        peakGpuBytes: number;
        memoryBudgetBytes: number;
        bufferCreations: number;
        p95Ms: number;
        disposed: boolean;
        deviceLost: boolean;
    };
    dispose(): void;
}
