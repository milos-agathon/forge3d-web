import type { PersistentByteCache, ByteReadProgress } from "./index.js";
export type DatasetKind = "dem" | "vector" | "overlay" | "cityjson" | "geojson" | "copc";
export interface DatasetMetadata {
    name: string;
    kind: DatasetKind;
    description: string;
    bundled: boolean;
    filename: string;
    relativeUrl: string;
    format: string;
    sha256: string;
    byteLength?: number;
    /** Native repository storage; ordinary Git blobs use the raw endpoint. */
    gitLfs?: boolean;
    /** Original native registry digest, if stale relative to its committed asset. */
    nativeSha256?: string;
    crs?: string;
    version?: string;
    coordinateSpace?: "geographic" | "projected" | "normalized";
}
export interface DatasetRegistryOptions {
    /** Replacement registry, useful for application-owned datasets. */ entries?: readonly DatasetMetadata[];
    baseUrl?: string | URL;
    bundledBaseUrl?: string | URL;
    cache?: PersistentByteCache | null;
    maxAssetBytes?: number;
    memoryBudgetBytes?: number;
}
export interface DatasetFetchOptions {
    signal?: AbortSignal;
    offline?: boolean;
    onProgress?: (progress: ByteReadProgress) => void;
}
export interface DatasetDem {
    data: Float32Array;
    width: number;
    height: number;
    metadata: DatasetMetadata;
}
export interface DatasetDiagnostics {
    memoryBytes: number;
    memoryBudgetBytes: number;
    cachedEntries: number;
    activeRequests: number;
    persistent: boolean;
    disposed: boolean;
    gpuBytes: 0;
}
