import type { DatasetMetadata, DatasetRegistryOptions, DatasetFetchOptions, DatasetDem, DatasetDiagnostics } from "./dataset-types.js";
import type { CrsGeoJson } from "./crs-types.js";
export type * from "./dataset-types.js";
export declare const DATASET_BASE_URL = "https://media.githubusercontent.com/media/milos-agathon/forge3d/1f4084af428dc699bdcd108b029736cb73903926/assets/";
/** Registry and verified byte loader. Remote format decoding belongs to W15/W16. */
export declare class DatasetRegistry {
    #private;
    constructor(options?: DatasetRegistryOptions);
    info(name: string): DatasetMetadata;
    listDatasets(): DatasetMetadata[];
    datasetInfo(): Record<string, DatasetMetadata>;
    bundled(): string[];
    remote(): string[];
    available(): string[];
    url(name: string): URL;
    fetch(name: string, options?: DatasetFetchOptions): Promise<Uint8Array>;
    fetchDem(name: string, options?: DatasetFetchOptions): Promise<Uint8Array>;
    fetchCityJson(name: string, options?: DatasetFetchOptions): Promise<Uint8Array>;
    fetchCopc(name: string, options?: DatasetFetchOptions): Promise<Uint8Array>;
    miniDemUrl(): URL;
    sampleBoundariesUrl(): URL;
    miniDem(options?: DatasetFetchOptions): Promise<DatasetDem>;
    sampleBoundaries(options?: DatasetFetchOptions): Promise<CrsGeoJson>;
    getDiagnostics(): DatasetDiagnostics;
    dispose(): void;
}
/** Safe non-executable subset of NPY: C-order little-endian 2D float32 grids. */
export declare function decodeDatasetNpy(bytes: Uint8Array): Omit<DatasetDem, "metadata">;
