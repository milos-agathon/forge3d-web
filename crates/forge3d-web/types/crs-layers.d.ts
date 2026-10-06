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
};
/** Convert the horizontal X/Z map plane, preserving Y elevation and feature IDs. */
export declare function reprojectVectorLayer(transformer: CrsTransformer, input: GeospatialVectorLayerInput, target: CrsLayerTarget, options?: CrsTransformOptions): Promise<GeospatialVectorLayerInput>;
/** Asynchronous PROJ bridge for W13's synchronous label candidate recipes. */
export declare function reprojectLabelFeatures(transformer: CrsTransformer, features: Iterable<LabelFeature>, source: string, target: CrsLayerTarget, options?: LabelFeatureOptions, transformOptions?: CrsTransformOptions): Promise<LabelFeatureSource>;
