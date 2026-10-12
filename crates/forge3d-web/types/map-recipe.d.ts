import { type JsonValue } from './diagnostics.js';
import type { SceneRecipeInput, TerrainSourceInput, RasterOverlayInput, VectorOverlayInput, MapSceneBuildingLayerInput, MapSceneLabelLayerInput, MapScenePointCloudLayerInput, MapSceneTiles3DLayerInput, OrbitCameraInput, LightingPresetInput, OutputSpecInput, ReproducibilityProfileInput } from './map-scene-types.js';
import type { CameraInput } from './index.js';
export declare const MAP_SCENE_RECIPE_SCHEMA = "forge3d.mapscene.recipe.v1";
export declare function encodeMapData(value: unknown, maxBytes?: number): JsonValue;
export declare function decodeMapData(value: unknown, maxBytes?: number): unknown;
export declare function mapCamera(input: CameraInput | OrbitCameraInput): CameraInput;
export declare class TerrainSource implements TerrainSourceInput {
    readonly kind = "terrain-source";
    readonly source: TerrainSourceInput['source'];
    requestedStats?: readonly string[];
    constructor(input: TerrainSourceInput);
}
export declare class RasterOverlay implements RasterOverlayInput {
    readonly kind = "raster";
    layerId: string;
    source: RasterOverlayInput['source'];
    constructor(input: Omit<RasterOverlayInput, 'kind'>);
}
export declare class VectorOverlay implements VectorOverlayInput {
    readonly kind = "vector";
    layerId: string;
    source: VectorOverlayInput['source'];
    constructor(input: Omit<VectorOverlayInput, 'kind'>);
}
export declare class MapSceneBuildingLayer implements MapSceneBuildingLayerInput {
    readonly kind = "buildings";
    layerId: string;
    source: MapSceneBuildingLayerInput['source'];
    constructor(input: Omit<MapSceneBuildingLayerInput, 'kind'>);
}
export declare class MapSceneLabelLayer implements MapSceneLabelLayerInput {
    readonly kind = "labels";
    layerId: string;
    source: MapSceneLabelLayerInput['source'];
    constructor(input: Omit<MapSceneLabelLayerInput, 'kind'>);
}
export declare class MapScenePointCloudLayer implements MapScenePointCloudLayerInput {
    readonly kind = "point-cloud";
    layerId: string;
    source: MapScenePointCloudLayerInput['source'];
    constructor(input: Omit<MapScenePointCloudLayerInput, 'kind'>);
}
export declare class MapSceneTiles3DLayer implements MapSceneTiles3DLayerInput {
    readonly kind = "tiles3d";
    layerId: string;
    source: MapSceneTiles3DLayerInput['source'];
    constructor(input: Omit<MapSceneTiles3DLayerInput, 'kind'>);
}
export declare class OrbitCamera implements OrbitCameraInput {
    readonly kind = "orbit-camera";
    target: [
        number,
        number,
        number
    ];
    distance: number;
    constructor(input: Omit<OrbitCameraInput, 'kind'>);
}
export declare class LightingPreset implements LightingPresetInput {
    name: 'default' | 'daylight' | 'overcast' | 'sunset';
    constructor(input?: LightingPresetInput);
}
export declare class OutputSpec implements OutputSpecInput {
    width: number;
    height: number;
    readonly format = "png";
    constructor(input: OutputSpecInput);
}
export declare class ReproducibilityProfile implements ReproducibilityProfileInput {
    seed: number;
    constructor(input?: ReproducibilityProfileInput);
}
export interface RasterOverlay extends RasterOverlayInput {
}
export interface VectorOverlay extends VectorOverlayInput {
}
export interface MapSceneBuildingLayer extends MapSceneBuildingLayerInput {
}
export interface MapSceneLabelLayer extends MapSceneLabelLayerInput {
}
export interface MapScenePointCloudLayer extends MapScenePointCloudLayerInput {
}
export interface MapSceneTiles3DLayer extends MapSceneTiles3DLayerInput {
}
export interface OrbitCamera extends OrbitCameraInput {
}
export interface LightingPreset extends LightingPresetInput {
}
export interface ReproducibilityProfile extends ReproducibilityProfileInput {
}
export declare class SceneRecipe {
    #private;
    constructor(input: SceneRecipeInput);
    get value(): SceneRecipeInput;
    toJSON(): JsonValue;
    serialize(): string;
    static fromJSON(input: unknown): SceneRecipe;
}
