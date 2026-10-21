import type { CameraInput, Forge3DRuntimeOptions, TerrainHeightmapInput, TerrainOverlayLayerInput, LightInput, EnvironmentInput, PostFxChainInput, ShadowConfigInput, CascadedShadowConfigInput, SceneNodeInput, ScatterBatchInput, TerrainProbeSnapshot, MaterialInput, IblSnapshot } from './index.js';
export type { MapSceneRenderContext } from './map-render-context.js';
import type { VectorLayerInput } from './vector-types.js';
import type { LabelRecord, LabelPlanOptions, LabelStyleInput, KeepoutRegionInput, LabelPlanData } from './label-types.js';
import type { BuildingInput, BuildingLayerOptions } from './buildings.js';
import type { PointData, PointCloudDataset, PointStyle, PointTraversalOptions } from './pointcloud-types.js';
import type { MeshInput } from './mesh.js';
import type { TraceTriangle, TraceMaterial, TraceLight, TraceMedium } from './trace-types.js';
import type { SdfSnapshot } from './sdf.js';
import type { JsonValue, SupportLevel, RenderFailurePolicyValue } from './diagnostics.js';
/** A resource has one identity and either inline data or a URL. Integrity is checked before use. */
export interface MapResource<T = unknown> {
    id: string;
    format: string;
    data?: T;
    url?: string;
    sha256?: string;
    crs?: string;
    /** Hard limit for fetch/decode; defaults to the recipe's per-resource limit. */
    maxBytes?: number;
    parameters?: Record<string, JsonValue>;
    baseUrl?: string;
}
export interface TerrainSourceInput {
    kind?: 'terrain-source';
    source: MapResource<TerrainHeightmapInput>;
    requestedStats?: readonly string[];
}
export interface MapLayerBase {
    layerId: string;
    supportLevel?: SupportLevel;
    metadata?: Record<string, JsonValue>;
    /** Preserve product-only diagnostics until the requested path has an adapter. */
    instancingPath?: string;
    requestedStats?: readonly string[];
}
export interface RasterOverlayInput extends MapLayerBase {
    kind: 'raster';
    source: MapResource<TerrainOverlayLayerInput['image']>;
    options?: Omit<TerrainOverlayLayerInput, 'image' | 'name'>;
}
export interface VectorOverlayInput extends MapLayerBase {
    kind: 'vector';
    source: MapResource<VectorLayerInput>;
}
export interface MapSceneLabelLayerInput extends MapLayerBase {
    kind: 'labels';
    source: MapResource<readonly LabelRecord[]>;
    style?: LabelStyleInput;
    plan?: LabelPlanData;
    priorityRules?: LabelPlanOptions['priority_rules'];
    typography?: LabelPlanOptions['typography'];
    atlasGlyphs?: readonly string[];
    keepouts?: readonly KeepoutRegionInput[];
    coordinateSpace?: 'screen' | 'world';
}
export interface MapSceneBuildingLayerInput extends MapLayerBase {
    kind: 'buildings';
    source: MapResource<readonly BuildingInput[] | Record<string, unknown>>;
    options?: BuildingLayerOptions;
    transforms?: Float32Array;
}
export interface MapSceneMeshLayerInput extends MapLayerBase {
    kind: 'mesh';
    source: MapResource<MeshInput>;
    transforms?: Float32Array;
}
export interface MapScenePointCloudLayerInput extends MapLayerBase {
    kind: 'point-cloud';
    source: MapResource<PointData>;
    style?: PointStyle;
    traversal?: PointTraversalOptions;
    origin?: readonly [
        number,
        number,
        number
    ];
}
export interface MapSceneTiles3DLayerInput extends MapLayerBase {
    kind: 'tiles3d';
    source: MapResource<Record<string, unknown>>;
    origin?: readonly [
        number,
        number,
        number
    ];
    traversal?: {
        sseThreshold?: number;
        maxDepth?: number;
        maxTiles?: number;
    };
}
export interface MapSceneNodeLayerInput extends MapLayerBase {
    kind: 'nodes';
    nodes: readonly SceneNodeInput[];
}
export interface MapSceneScatterLayerInput extends MapLayerBase {
    kind: 'scatter';
    batches: readonly ScatterBatchInput[];
}
export interface MapSceneTraceLayerInput extends MapLayerBase {
    kind: 'trace';
    triangles?: readonly TraceTriangle[];
    sdf?: SdfSnapshot;
    materials?: readonly TraceMaterial[];
    lights?: readonly TraceLight[];
    environment?: readonly [
        number,
        number,
        number
    ];
    medium?: TraceMedium;
    samples?: number;
    maxBounces?: number;
}
export interface MapSceneDiagnosticLayerInput extends MapLayerBase {
    kind: 'diagnostic';
    feature: string;
    supportLevel: Exclude<SupportLevel, 'supported'>;
}
export type MapSceneLayerInput = RasterOverlayInput | VectorOverlayInput | MapSceneLabelLayerInput | MapSceneBuildingLayerInput | MapSceneMeshLayerInput | MapScenePointCloudLayerInput | MapSceneTiles3DLayerInput | MapSceneNodeLayerInput | MapSceneScatterLayerInput | MapSceneTraceLayerInput | MapSceneDiagnosticLayerInput;
export interface OrbitCameraInput {
    kind: 'orbit-camera';
    target: [
        number,
        number,
        number
    ];
    distance: number;
    azimuthDegrees?: number;
    elevationDegrees?: number;
    fovYDegrees?: number;
    near?: number;
    far?: number;
}
export interface LightingPresetInput {
    name?: 'default' | 'daylight' | 'overcast' | 'sunset';
    lights?: readonly LightInput[];
    sunDirection?: [
        number,
        number,
        number
    ];
    intensity?: number;
}
export interface OutputSpecInput {
    width: number;
    height: number;
    format?: 'png';
}
export interface ReproducibilityProfileInput {
    seed?: number;
    rendererBackend?: 'webgpu' | 'cpu';
    pixelTolerance?: number;
    assetHashesOrIds?: Record<string, string>;
}
export interface SceneRecipeInput {
    terrain?: TerrainSourceInput;
    layers?: readonly MapSceneLayerInput[];
    camera: CameraInput | OrbitCameraInput;
    crs?: string;
    lighting?: LightingPresetInput;
    output: OutputSpecInput;
    renderPolicy?: RenderFailurePolicyValue;
    diagnosticsPolicy?: {
        gpuMemoryBudgetBytes?: number;
        maxResourceBytes?: number;
        /** Aggregate serialization guard, defaulting to the largest configured resource limit. */
        maxRecipeBytes?: number;
        maxLayers?: number;
        /** Browser output guard; default 16 megapixels, still subject to device/GPU budgets. */
        maxOutputPixels?: number;
        largeSceneSummary?: boolean;
    };
    reproducibility?: ReproducibilityProfileInput;
    environment?: EnvironmentInput;
    postFx?: PostFxChainInput;
    shadows?: ShadowConfigInput;
    cascadedShadows?: CascadedShadowConfigInput;
    lightingProbes?: TerrainProbeSnapshot;
    materials?: readonly {
        slot: string;
        material: MaterialInput;
    }[];
    ibl?: IblSnapshot;
    timeSeconds?: number;
    runtimeOptions?: Omit<Forge3DRuntimeOptions, 'width' | 'height' | 'devicePixelRatio' | 'memoryBudgetBytes'>;
    /** Furniture composition is owned by W20. Intent is diagnosed until its adapter exists. */
    mapFurniture?: Record<string, JsonValue>;
}
export interface MapSceneResourceSummary {
    id: string;
    format: string;
    layerIds: string[];
    state: 'inline' | 'unresolved' | 'ready' | 'failed';
    estimatedBytes: number;
    sha256: string | null;
    url: string | null;
}
export interface MapSceneProgress {
    phase: 'validate' | 'load' | 'render' | 'encode';
    completed: number;
    total: number;
    resourceId?: string;
}
export interface MapFrameMetrics {
    gpuBytes: number;
    peakGpuBytes: number;
    coveragePixels: number;
    drawCalls: number;
    pointCount: number;
    backend: 'webgpu' | 'cpu';
}
export interface MapSceneRenderOptions {
    /** Reuse a device within an explicit scope; all frame resources stay independent. */
    renderContext?: import('./map-render-context.js').MapSceneRenderContext;
    signal?: AbortSignal;
    canvas?: HTMLCanvasElement | OffscreenCanvas;
    onProgress?: (progress: MapSceneProgress) => void;
    sink?: WritableStream<Uint8Array>;
}
export interface PreparedMapResource {
    resource: MapResource;
    value: unknown;
    bytes: number;
    dispose?: () => void;
}
export interface PreparedPointSource {
    dataset: PointCloudDataset;
}
