import { type CartographicColor } from './cartography-common.js';
import type { Frame } from "./index.js";
export interface NorthArrowConfig {
    style?: 'arrow' | 'compass' | 'simple';
    size?: number;
    rotationDeg?: number;
    color?: CartographicColor;
    background?: CartographicColor;
    showNLabel?: boolean;
    fontSize?: number;
    borderWidth?: number;
    borderColor?: CartographicColor;
}
export declare class NorthArrow {
    readonly config: Readonly<Required<NorthArrowConfig>>;
    constructor(config?: NorthArrowConfig);
    /** North tip, in local image pixels, after clockwise rotation. */
    tip(): [number, number];
    render(): Promise<Frame>;
}
