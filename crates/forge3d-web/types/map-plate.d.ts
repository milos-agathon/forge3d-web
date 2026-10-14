import { Frame } from "./index.js";
import { BBox, PlateRegion, type MapPlateConfig, type PlateLayout, type PositionAnchor } from './map-layout.js';
import { type CartographicColor } from './cartography-common.js';
import { type PlateImage } from './cartography-canvas.js';
export interface PlateTitleOptions {
    position?: PositionAnchor;
    fontSize?: number;
    color?: CartographicColor;
}
export interface PlateInsetOptions {
    position?: PositionAnchor;
    size?: readonly [number, number];
    borderWidth?: number;
    borderColor?: CartographicColor;
}
/** Canvas/OffscreenCanvas composition. Owns copies of input pixels; no GPU/session ownership. */
export declare class MapPlate {
    #private;
    readonly config: Readonly<Required<MapPlateConfig>>;
    constructor(config?: MapPlateConfig);
    get disposed(): boolean;
    get bbox(): BBox | undefined;
    getMemoryReport(): {
        cpuBytes: number;
        workingBytes: number;
        peakBytes: number;
        imageCount: number;
        disposed: boolean;
    };
    setMapRegion(image: PlateImage, bbox: BBox): this;
    addTitle(text: string, options?: PlateTitleOptions): this;
    addLegend(image: PlateImage, position?: PositionAnchor): this;
    addScaleBar(image: PlateImage, position?: PositionAnchor): this;
    addNorthArrow(image: PlateImage, position?: PositionAnchor): this;
    addInset(image: PlateImage, options?: PlateInsetOptions): this;
    mapRegion(): PlateRegion;
    /** Floor-rounded native placement. Includes the actual letterboxed map rectangle. */
    layout(options?: {
        signal?: AbortSignal;
    }): Promise<PlateLayout>;
    compose(options?: {
        signal?: AbortSignal;
    }): Promise<Frame>;
    exportPng(options?: {
        signal?: AbortSignal;
    }): Promise<Blob>;
    exportJpeg(options?: {
        quality?: number;
        signal?: AbortSignal;
    }): Promise<Blob>;
    clear(): void;
    dispose(): void;
}
