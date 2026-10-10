import type { PointVec3, PointBounds, PointView } from "./pointcloud-types.js";
export declare const POINT_MAX_BYTES: number;
export declare function pointError(message: string, reason?: string): never;
export declare function pointLimit(bytes: number, budget?: number): void;
export declare function pointInteger(n: number, name: string, min?: number, max?: number): number;
export declare function pointFinite(n: number, name: string): number;
export declare function pointCancelled(signal?: AbortSignal): void;
/** Cancellation stops this subscriber promptly without cancelling another page reader. */
export declare function pointAwait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
export declare function pointLive(disposed: boolean): void;
export declare function pointView(view: PointView): void;
export declare function checkBounds(b: PointBounds): PointBounds;
export declare function boundsCenter(b: PointBounds): PointVec3;
export declare function boundsRadius(b: PointBounds): number;
export declare function pointDistance(a: PointVec3, b: PointVec3): number;
/** Test all six homogeneous planes without dividing by w or culling a crossing box. */
export declare function boundsInView(b: PointBounds, m?: ArrayLike<number>): boolean;
export declare function pointJson(bytes: Uint8Array): Record<string, unknown>;
export declare function pointU64(v: DataView, offset: number): number;
export declare function pointUrl(uri: string, base: string | URL): string;
/** Byte-bounded decoded LRU. Admission rejects a single oversized item before evicting. */
export declare class PointCache<T> {
    readonly budget: number;
    readonly entries: Map<string, {
        value: T;
        bytes: number;
    }>;
    bytes: number;
    hits: number;
    misses: number;
    evictions: number;
    peakBytes: number;
    constructor(budget: number);
    get(key: string): T | undefined;
    put(key: string, value: T, bytes: number): void;
    delete(key: string): void;
    clear(): void;
    stats(): {
        cacheUsed: number;
        cacheBudget: number;
        entryCount: number;
        hits: number;
        misses: number;
        evictions: number;
        peakBytes: number;
    };
}
