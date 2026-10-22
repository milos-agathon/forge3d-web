import { type BrowserByteSource } from "./index.js";
import { ValidationReport } from './diagnostics.js';
import { type StyleEvalContext } from './style-expressions.js';
import type { VectorFeature, VectorColor, VectorStyle } from './vector-types.js';
import type { LabelRecord, LabelStyleInput } from './label-types.js';
import type { MapSceneLayerInput } from './map-scene-types.js';
export interface StyleLayer {
    id: string;
    type: string;
    source?: string;
    'source-layer'?: string;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    filter?: unknown[];
    minzoom?: number;
    maxzoom?: number;
}
export interface StyleSpecInput {
    version?: number;
    name?: string;
    sources?: Record<string, unknown>;
    layers?: readonly StyleLayer[];
    sprite?: string;
    glyphs?: string;
    [key: string]: unknown;
}
export declare class StyleSpec {
    #private;
    constructor(input: StyleSpecInput);
    get value(): StyleSpecInput;
    get layers(): StyleLayer[];
    layerById(id: string): StyleLayer | undefined;
    layersForSourceLayer(name: string): StyleLayer[];
    layersByType(type: string): StyleLayer[];
    toJSON(): StyleSpecInput;
    validate(): ValidationReport;
}
export declare function parseStyle(input: StyleSpecInput | string): StyleSpec;
export declare function loadStyle(source: BrowserByteSource | FileSystemFileHandle, options?: {
    signal?: AbortSignal;
    maxBytes?: number;
}): Promise<StyleSpec>;
export declare function parseStyleColor(input: unknown): VectorColor | null;
export declare function styleLayerVisible(layer: StyleLayer, zoom?: number): boolean;
export declare function styleToVectorStyle(layer: StyleLayer, context?: StyleEvalContext): VectorStyle;
export declare function styleToLabelStyle(layer: StyleLayer, context?: StyleEvalContext): LabelStyleInput;
export declare function styleLabelRecords(layer: StyleLayer, features: readonly VectorFeature[], zoom?: number): LabelRecord[];
/** Each feature uses its first matching native layer. Symbols retain their native diagnostic. */
export declare function compileStyle(spec: StyleSpec, sources: Record<string, readonly VectorFeature[]>, options?: {
    zoom?: number;
    crs?: string;
}): {
    layers: MapSceneLayerInput[];
    report: ValidationReport;
};
/** GeoJSON [x,z,elevation] maps to the engine's [x,elevation,z] convention. Multi-geometries retain source identity in properties. */
export declare function styleFeaturesFromGeoJson(input: unknown): VectorFeature[];
/** Load only GeoJSON sources. Streamed MVT sources retain the explicit unsupported contract. */
export declare function loadStyleLayers(spec: StyleSpec, options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    baseUrl?: string;
    zoom?: number;
    crs?: string;
}): Promise<ReturnType<typeof compileStyle>>;
