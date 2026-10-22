import type { LoadedTile } from './tiles3d-layer.js';
import type { PointData, PointVec3 } from './pointcloud-types.js';
import { type MeshBuffers } from './mesh.js';
export interface TileMesh {
    name: string;
    mesh: MeshBuffers;
    material: Readonly<Record<string, unknown>> | undefined;
}
/** Immutable selection view: each transform/aggregation is performed once, then reused. */
export declare class CommittedTileView {
    #private;
    private readonly loaded;
    readonly name: string;
    readonly maxBytes: number;
    readonly origin: PointVec3;
    constructor(loaded: readonly LoadedTile[], name: string, origin: PointVec3, maxBytes: number);
    sceneMesh(item: TileMesh): MeshBuffers;
    points(): PointData;
    meshes(): {
        name: string;
        mesh: MeshBuffers;
        material: Readonly<Record<string, unknown>> | undefined;
    }[];
}
