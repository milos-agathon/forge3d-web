import type { CrsTransformer } from "./crs.js";
import type { CrsTransformOptions } from "./crs-types.js";
import type { VectorLayerInput } from "./vector-types.js";
import type { LabelFeature, LabelFeatureOptions } from "./label-features.js";
import { LabelFeatureSource } from "./label-features.js";
export type GeospatialVectorLayerInput = VectorLayerInput & {
    crs: string;
};
export type CrsLayerTarget = string | {
    readonly crs: string | undefined;
    readonly transform?: readonly [number, number, number, number, number, number] | undefined;
    readonly width?: number;
    readonly height?: number;
    readonly spacing?: readonly [number, number];
};
/** Convert the horizontal X/Z map plane, preserving Y elevation and feature IDs. */
export declare function reprojectVectorLayer(transformer: CrsTransformer, input: GeospatialVectorLayerInput, target: CrsLayerTarget, options?: CrsTransformOptions): Promise<VectorLayerInput>;
/** Asynchronous PROJ bridge for W13's synchronous label candidate recipes. */
export declare function reprojectLabelFeatures(transformer: CrsTransformer, features: Iterable<LabelFeature>, source: string, target: CrsLayerTarget, options?: LabelFeatureOptions, transformOptions?: CrsTransformOptions): Promise<LabelFeatureSource>;
