import { type CartographicColor } from './cartography-common.js';
import type { LabelPlanData } from './label-types.js';
import type { VectorLayerInput } from './vector-types.js';
export type ExportPoint = readonly [number, number];
export interface ExportVectorStyle {
    fillColor?: CartographicColor;
    strokeColor?: CartographicColor;
    strokeWidth?: number;
}
export interface ExportLabelStyle {
    fontSize?: number;
    color?: CartographicColor;
    haloColor?: CartographicColor;
    haloWidth?: number;
    fontFamily?: string;
    fontWeight?: string;
}
export interface ExportPolygon {
    exterior: ExportPoint[];
    holes: ExportPoint[][];
    style: Required<ExportVectorStyle>;
}
export interface ExportPolyline {
    path: ExportPoint[];
    style: Required<ExportVectorStyle>;
}
export interface ExportLabel {
    text: string;
    position: ExportPoint;
    style: Required<ExportLabelStyle>;
}
export declare class Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    constructor(minX?: number, minY?: number, maxX?: number, maxY?: number);
    validate(): void;
    get width(): number;
    get height(): number;
    get center(): ExportPoint;
    expandToInclude(p: ExportPoint): void;
    withPadding(padding: number): Bounds;
    static fromPoints(p: readonly ExportPoint[]): Bounds | null;
}
/** Native bounds-to-viewport convention, including degenerate-range fallback and Y flip. */
export declare function project2dToScreen(p: ExportPoint, bounds: Bounds, viewport: ExportPoint): [number, number];
/** Column-major matrix; offscreen points extrapolate, w<=0 is rejected. */
export declare function project3dTo2d(p: readonly [number, number, number], matrix: ArrayLike<number>, viewport: ExportPoint): [number, number] | null;
export declare class VectorScene {
    #private;
    readonly maxBytes: number;
    constructor(maxBytes?: number);
    get polygons(): ExportPolygon[];
    get polylines(): ExportPolyline[];
    get labels(): ExportLabel[];
    addPolygon(exterior: readonly ExportPoint[], options?: ExportVectorStyle & {
        holes?: readonly (readonly ExportPoint[])[];
    }): this;
    addPolyline(path: readonly ExportPoint[], options?: ExportVectorStyle): this;
    addLabel(text: string, position: ExportPoint, options?: ExportLabelStyle): this;
    computeBounds(padding?: number): Bounds;
    /** Accepted W13 labels are already in screen space. Bounds must match this viewport with Y reversed. */
    addLabelPlan(plan: LabelPlanData, viewportHeight: number, options?: ExportLabelStyle): this;
    getMemoryReport(): {
        cpuBytes: number;
        disposed: boolean;
    };
    clear(): void;
    dispose(): void;
}
/** W12 world X/Z geometry adapter. Hidden layers are omitted and zOrder is stable. */
export declare function vectorSceneFromLayers(layers: readonly VectorLayerInput[]): VectorScene;
