import type { PointVec3, PointBounds } from "./pointcloud-types.js";
export type TileBoundsInput = {
    sphere: number[];
} | {
    box: number[];
} | {
    region: number[];
};
export declare const TILE_IDENTITY: number[];
export declare function multiplyTileMatrices(a: ArrayLike<number>, b: ArrayLike<number>): number[];
export declare function tileMatrix(m: unknown): number[];
export declare function transformTilePoint(m: ArrayLike<number>, p: PointVec3): PointVec3;
export declare function tileMatrixScale(m: ArrayLike<number>): number;
export declare function wgs84ToEcef(lon: number, lat: number, height: number): PointVec3;
export declare class TileBoundingVolume {
    readonly type: "sphere" | "box" | "region";
    readonly data: number[];
    constructor(input: TileBoundsInput);
    center(): PointVec3;
    radius(): number;
    transform(matrix: ArrayLike<number>): TileBoundingVolume;
    aabb(): PointBounds;
    intersectsFrustum(matrix?: ArrayLike<number>): boolean;
}
