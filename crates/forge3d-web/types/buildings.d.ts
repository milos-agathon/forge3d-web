import type { BrowserByteSource, ByteReadOptions, Forge3DScene } from "./index.js";
import type { MeshBuffers, MeshInput, MeshBounds, Vec3 } from "./mesh.js";
import type { BuildingMaterial, RoofType } from "./building-materials.js";
import type { BuildingTextureRequest, BuildingTextureReport } from "./building-diagnostics.js";
import type { GltfAsset } from "./mesh-gltf.js";
import type { CrsTransformer } from "./crs.js";
export interface BuildingInput {
    id: string;
    mesh: MeshInput;
    height?: number | null;
    groundHeight?: number | null;
    roofType?: RoofType;
    material?: Partial<BuildingMaterial>;
    lod?: number;
    attributes?: Readonly<Record<string, unknown>>;
}
export interface BuildingRecord {
    id: string;
    mesh: MeshBuffers;
    height: number | null;
    groundHeight: number | null;
    roofType: RoofType;
    material: BuildingMaterial;
    lod: number;
    attributes: Record<string, unknown>;
}
export interface BuildingLayerOptions {
    name?: string;
    crs?: string;
    textures?: readonly BuildingTextureRequest[];
    proGated?: boolean;
}
export interface BuildingLoadOptions extends ByteReadOptions, BuildingLayerOptions {
    format?: "geojson" | "cityjson";
    defaultHeight?: number;
    heightKey?: string;
    origin?: Vec3;
    transformer?: CrsTransformer;
    targetCrs?: string;
}
/** Geometry stays in its source Z-up axes; rendering rotates it to browser Y-up. */
export declare class BuildingLayer {
    #private;
    readonly name: string;
    readonly crs: string | undefined;
    constructor(buildings: readonly BuildingInput[], options?: BuildingLayerOptions);
    get disposed(): boolean;
    get buildingCount(): number;
    get totalVertices(): number;
    get totalTriangles(): number;
    get maxLod(): number;
    get cpuBytes(): number;
    buildings(): BuildingRecord[];
    bounds(): MeshBounds | null;
    validate(): BuildingTextureReport;
    /** Uses scene scalar BRDF materials, shared instancing, LOD and resource ownership. */
    addToScene(scene: Forge3DScene, options?: {
        lodRatios?: readonly number[];
        lodDistances?: readonly number[];
        transforms?: Float32Array;
    }): void;
    dispose(): void;
    static fromGltf(asset: GltfAsset, options?: BuildingLayerOptions): BuildingLayer;
}
export declare function parseGeoJsonBuildings(value: unknown, o?: BuildingLoadOptions): BuildingLayer;
/** Shared MultiPolygonZ surface decoder used by CityJSON and public geometry IO. */
export declare function meshFromMultiPolygonZ(polygons: readonly (readonly (readonly Vec3[])[])[]): MeshBuffers;
export declare function parseCityJsonBuildings(value: unknown, o?: BuildingLoadOptions): BuildingLayer;
export declare function loadBuildings(source: BrowserByteSource, o?: BuildingLoadOptions): Promise<BuildingLayer>;
/** Native public 3D Tiles building metadata was explicitly incomplete. W16 owns traversal. */
export declare function loadBuildingTilesMetadata(source: BrowserByteSource, o?: ByteReadOptions): Promise<{
    tileset: Record<string, unknown>;
    status: "underdeveloped";
    diagnostics: {
        code: "python_public_3dtiles_incomplete";
        severity: "error";
    }[];
}>;
