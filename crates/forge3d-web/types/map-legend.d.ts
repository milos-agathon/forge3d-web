import { Colormap } from './colormaps.js';
import { type CartographicColor } from './cartography-common.js';
import { Frame } from "./index.js";
export interface LegendConfig {
    orientation?: 'vertical' | 'horizontal';
    barWidth?: number;
    barHeight?: number;
    tickCount?: number;
    tickLength?: number;
    labelFormat?: string;
    labelSuffix?: string;
    fontSize?: number;
    title?: string;
    titleFontSize?: number;
    padding?: number;
    background?: CartographicColor;
    tickColor?: CartographicColor;
    labelColor?: CartographicColor;
}
export declare class Legend {
    readonly colormap: Colormap;
    readonly domain: readonly [number, number];
    readonly config: Readonly<Required<LegendConfig>>;
    constructor(colormap: Colormap | Float32Array, domain: readonly [number, number], config?: LegendConfig);
    getTicks(): [number, string][];
    /** Exact native nearest-index gradient and linear-to-display conversion. */
    gradient(): Frame;
    render(): Promise<Frame>;
}
