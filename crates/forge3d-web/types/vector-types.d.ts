/** Vector IDs reserve zero for background and remain stable across edits. */
export type VectorFeatureId = number;
export type VectorPosition = [number, number, number];
export type VectorColor = [number, number, number, number];
export type VectorOitMode = "auto" | "standard" | "wboit" | "dual-source";
export type VectorPointShape = "circle" | "square" | "diamond" | "triangle" | "texture" | "sphere";
export interface VectorStyle {
    color?: VectorColor;
    opacity?: number;
    pointSize?: number;
    shape?: VectorPointShape;
    lodThreshold?: number;
    atlasTile?: number;
    lineWidth?: number;
    cap?: "butt" | "round" | "square";
    join?: "miter" | "bevel" | "round";
    miterLimit?: number;
    drape?: boolean;
    drapeOffset?: number;
    depthBias?: number;
    extrusion?: number;
}
export interface VectorPointFeature {
    id: VectorFeatureId;
    kind: "point";
    position: VectorPosition;
    style?: VectorStyle;
    properties?: Record<string, unknown>;
}
export interface VectorLineFeature {
    id: VectorFeatureId;
    kind: "line";
    positions: VectorPosition[];
    style?: VectorStyle;
    properties?: Record<string, unknown>;
}
export interface VectorPolygonFeature {
    id: VectorFeatureId;
    kind: "polygon";
    rings: VectorPosition[][];
    style?: VectorStyle;
    properties?: Record<string, unknown>;
}
export type VectorFeature = VectorPointFeature | VectorLineFeature | VectorPolygonFeature;
export interface VectorAtlas {
    width: number;
    height: number;
    tileSize: number;
    rgba: Uint8Array;
}
export interface VectorLayerInput {
    name: string;
    features: VectorFeature[];
    style?: VectorStyle;
    visible?: boolean;
    zOrder?: number;
    atlas?: VectorAtlas;
}
export interface VectorLayerSnapshot extends VectorLayerInput {
    layerId: number;
    visible: boolean;
    zOrder: number;
}
export interface VectorSelectionStyle {
    color?: VectorColor;
    outline?: boolean;
    outlineWidth?: number;
    glow?: boolean;
    glowIntensity?: number;
    glowRadius?: number;
    pulseSpeed?: number;
}
export interface VectorSelectionSet {
    name: string;
    ids: number[];
    visible: boolean;
    style: VectorSelectionStyle;
}
export interface VectorSnapshot {
    layers: VectorLayerSnapshot[];
    oit: VectorOitMode;
    culling: "auto" | "cpu" | "gpu";
    selections: VectorSelectionSet[];
    hover: number | null;
    hoverStyle: VectorSelectionStyle;
    timeSeconds: number;
}
export interface VectorReport {
    pipelineCreations:number;
    vertexBufferCreations:number;
    pickRenderCount:number;
    pickReadbackPeakBytes:number;
    requestedOit: VectorOitMode;
    effectiveOit: "standard" | "wboit" | "dual-source";
    fallbackReason: string | null;
    effectiveCulling: "cpu" | "gpu";
    effectiveExtrusion: "cpu" | "gpu";
    featureCount: number;
    triangleCount: number;
    gpuBytes: number;
    width: number;
    height: number;
}
export interface VectorPickRegion { x:number; y:number; width:number; height:number; }
export interface VectorProjectionReport { gpu:Uint8Array; cpu:Uint8Array; vertexCount:number; byteIdentical:boolean; }
export interface PickOptions {
    signal?: AbortSignal;
}
export interface VectorPickResult {
    id: number;
    layerId: number;
    layerName: string;
    kind: VectorFeature["kind"];
    properties: Record<string, unknown>;
    pixel: [number, number];
    depth: number;
    worldPosition: VectorPosition;
}
export interface TerrainPickResult {
    kind: "terrain";
    worldPosition: VectorPosition;
    normal: VectorPosition;
    distance: number;
}
export interface VectorPickMap {
    x?:number;
    y?:number;
    width: number;
    height: number;
    ids: Uint32Array;
    depth: Float32Array;
    worldPositions: Float32Array;
}
export interface VectorGraphInput {
    name: string;
    nodes: Array<{
        id: number;
        position: VectorPosition;
        style?: VectorStyle;
        properties?: Record<string, unknown>;
    }>;
    edges: Array<{
        id: number;
        source: number;
        target: number;
        style?: VectorStyle;
        properties?: Record<string, unknown>;
    }>;
    nodeStyle?: VectorStyle;
    edgeStyle?: VectorStyle;
    drape?: boolean;
}
