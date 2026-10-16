import type { Forge3DScene } from "./index.js";
import type { PointData, PointVec3, PointView } from "./pointcloud-types.js";
import { Tileset, TilesetTraverser } from "./tiles3d.js";
import type { TilesetTraversalOptions, VisibleTile } from "./tiles3d.js";
import type { B3dmContent, PntsContent } from "./tiles3d-content.js";
import { PointCache } from "./pointcloud-common.js";
import type { MeshBuffers } from "./mesh.js";
import { PointCloudLayer } from "./pointcloud-layer.js";
export type TilePayload = PntsContent | B3dmContent;
export interface Tiles3dLayerOptions extends TilesetTraversalOptions {
    name?: string;
    maxBytes?: number;
    ownsTileset?: boolean;
    origin?: PointVec3;
}
export interface LoadedTile {
    selection: VisibleTile;
    content: TilePayload;
}
/** Bounded content cache and transactional selection; replacements remain visible until ready. */
export declare class Tiles3dLayer {
    #private;
    readonly tileset: Tileset;
    readonly name: string;
    readonly origin: PointVec3;
    readonly traverser: TilesetTraverser;
    readonly cache: PointCache<TilePayload>;
    readonly maxBytes: number;
    readonly ownsTileset: boolean;
    constructor(tileset: Tileset, options?: Tiles3dLayerOptions);
    update(view: PointView, signal?: AbortSignal): Promise<LoadedTile[]>;
    loadedTiles(): LoadedTile[];
    pointData(): PointData;
    /** Point tiles use the compact point renderer. Mesh tiles use W15 scene batches. */
    asPointCloudLayer(): PointCloudLayer;
    meshes(): {
        name: string;
        mesh: MeshBuffers;
        material: Readonly<Record<string, unknown>> | undefined;
    }[];
    addMeshesToScene(scene: Forge3DScene): void;
    stats(): {
        visibleTileCount: number;
        pointCount: number;
        triangles: number;
        loadedBytes: number;
        cache: {
            cacheUsed: number;
            cacheBudget: number;
            entryCount: number;
            hits: number;
            misses: number;
            evictions: number;
            peakBytes: number;
        };
        disposed: boolean;
    };
    dispose(): void;
}
