import { BBox } from './map-layout.js';
import { type CartographicColor } from './cartography-common.js';
import { type CartographicRenderOptions } from './cartography-canvas.js';
import type { Frame } from './index.js';
export interface ScaleBarConfig {
    units?: 'm' | 'km' | 'mi' | 'ft';
    style?: 'simple' | 'alternating';
    widthPx?: number;
    heightPx?: number;
    divisions?: number;
    fontSize?: number;
    padding?: number;
    barHeight?: number;
    background?: CartographicColor;
    barColor1?: CartographicColor;
    barColor2?: CartographicColor;
    labelColor?: CartographicColor;
    borderColor?: CartographicColor;
}
export interface ScaleBarMetrics {
    distanceMeters: number;
    displayDistance: number;
    actualBarPx: number;
    label: string;
}
export declare class ScaleBar {
    readonly metersPerPixel: number;
    readonly config: Readonly<Required<ScaleBarConfig>>;
    constructor(metersPerPixel: number, config?: ScaleBarConfig);
    /** Native WGS84 longitude approximation. Projected bounds require an explicit metres-per-unit. */
    static computeMetersPerPixel(bbox: BBox, imageWidth: number, metersPerUnit?: number): number;
    metrics(): ScaleBarMetrics;
    render(options?: CartographicRenderOptions): Promise<Frame>;
}
