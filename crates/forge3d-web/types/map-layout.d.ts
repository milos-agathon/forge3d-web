import { type CartographicColor } from './cartography-common.js';
export type PositionAnchor = 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
export declare class BBox {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
    readonly crs: string;
    constructor(west: number, south: number, east: number, north: number, crs?: string);
    get width(): number;
    get height(): number;
    get centerLat(): number;
}
export declare class PlateRegion {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
    constructor(x0: number, y0: number, x1: number, y1: number);
    get width(): number;
    get height(): number;
    get rect(): [number, number, number, number];
}
/** Native floor-centered anchors, with explicit padding in pixels. */
export declare function positionPlateElement(size: readonly [number, number], anchor: PositionAnchor, region: PlateRegion, margin?: number): [number, number];
export interface MapPlateConfig {
    width?: number;
    height?: number;
    margin?: readonly [number, number, number, number];
    background?: CartographicColor;
    dpi?: number;
    maxBytes?: number;
}
export interface PlateLayout {
    mapRegion: PlateRegion;
    mapImage: PlateRegion | null;
    elements: {
        kind: string;
        rect: PlateRegion;
    }[];
}
export declare function fitPlateImage(width: number, height: number, region: PlateRegion): PlateRegion;
