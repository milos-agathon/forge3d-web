import type { CrsCoordinate, CrsMetadata, CrsTransformerOptions, CrsTransformOptions, CrsDiagnostics, CrsGeoJson, CrsRasterMetadata } from "./crs-types.js";
export type * from "./crs-types.js";
/** Lexical EPSG helper. Use parseCrs for database/WKT identification. */
export declare function crsToEpsg(crs: string): number | null;
export declare function crsFromRasterMetadata(metadata: CrsRasterMetadata): string | null;
export declare function crsFromGeoJson(input: CrsGeoJson): string;
export declare function projAvailable(): boolean;
/** A CPU projection worker independent of GPU/device lifetime. Dispose explicitly. */
export declare class CrsTransformer {
    #private;
    readonly maxPoints: number;
    private constructor();
    static create(options?: CrsTransformerOptions): Promise<CrsTransformer>;
    private initialize;
    private admit;
    private guard;
    private run;
    parseCrs(definition: string, options?: Pick<CrsTransformOptions, "signal">): Promise<CrsMetadata>;
    parseCrsFromWkt(wkt: string, options?: Pick<CrsTransformOptions, "signal">): Promise<string | null>;
    transformCoords(coords: readonly CrsCoordinate[], source: string, target: string, options?: CrsTransformOptions): Promise<number[][]>;
    transformCoords(coords: Float32Array | Float64Array, source: string, target: string, options?: CrsTransformOptions): Promise<Float64Array>;
    transformPipeline(coords: readonly CrsCoordinate[], pipeline: string, options?: CrsTransformOptions): Promise<number[][]>;
    transformPipeline(coords: Float32Array | Float64Array, pipeline: string, options?: CrsTransformOptions): Promise<Float64Array>;
    private transform;
    reprojectGeometry<T extends CrsGeoJson>(geometry: T, source: string, target: string, options?: CrsTransformOptions): Promise<T>;
    getDiagnostics(): CrsDiagnostics;
    dispose(): void;
}
