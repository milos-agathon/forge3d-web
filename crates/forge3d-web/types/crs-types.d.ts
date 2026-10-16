import type { PersistentByteCache, ByteReadProgress } from "./index.js";
export type CrsCoordinate = readonly [number, number] | readonly [number, number, number] | readonly [number, number, number, number];
export interface CrsAxis {
    name: string;
    abbreviation: string;
    direction: string;
    unitName: string;
    unitConversionFactor: number;
}
export interface CrsMetadata {
    definition: string;
    name: string;
    authority: string | null;
    code: string | null;
    epsg: number | null;
    type: number;
    wkt: string;
    axes: CrsAxis[];
}
export interface CrsGridAsset {
    name: string;
    url: string | URL;
    sha256: string;
    byteLength?: number;
    version: string;
}
export interface CrsTransformerOptions {
    /** null disables persistent storage. Omission probes W02 browser adapters. */
    cache?: PersistentByteCache | null;
    offline?: boolean;
    signal?: AbortSignal;
    /** Additional grids. The native conus fixture is bundled by default. */
    grids?: readonly CrsGridAsset[];
    bundledGrids?: boolean;
    maxAssetBytes?: number;
    memoryBudgetBytes?: number;
    maxPoints?: number;
    onProgress?: (progress: ByteReadProgress) => void;
}
export interface CrsTransformOptions {
    alwaysXY?: boolean;
    signal?: AbortSignal;
    /** Flat array tuple size; nested tuples infer it. */ stride?: 2 | 3 | 4;
}
export interface CrsDiagnostics {
    backend: "proj-wasm";
    version: "0.1.0-alpha9";
    workerCount: number;
    pendingCalls: number;
    assetBytes: number;
    wasmHeapBytes: number;
    reservedBytes: number;
    memoryBudgetBytes: number;
    gpuBytes: 0;
    disposed: boolean;
    networkEnabled: false;
    grids: string[];
    maxPoints: number;
}
export interface CrsGeoJson {
    type: string;
    coordinates?: unknown;
    geometries?: CrsGeoJson[];
    geometry?: CrsGeoJson | null;
    features?: CrsGeoJson[];
    bbox?: number[];
    [key: string]: unknown;
}
export interface CrsRasterMetadata {
    epsg?: number;
    crs?: string;
    wkt?: string;
    geoKeys?: Readonly<Record<string, unknown>>;
}
