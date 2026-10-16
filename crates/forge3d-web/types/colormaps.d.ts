import { type CartographicColor } from './cartography-common.js';
export type ColormapStop = readonly [number, string | readonly [number, number, number] | CartographicColor];
export interface ColormapEndcaps {
    under?: CartographicColor;
    over?: CartographicColor;
    bad?: CartographicColor;
}
export declare function hexToRgb(hex: string): [number, number, number];
export declare function hexToRgba(hex: string, alpha?: number): [number, number, number, number];
export declare function rgbToNormalized(rgb: readonly [number, number, number]): [number, number, number];
/** Immutable sampled colormap in linear sRGB. Accessors return copies. */
export declare class Colormap {
    #private;
    readonly name: string;
    constructor(name: string, rgba: Float32Array | readonly number[], caps?: ColormapEndcaps);
    get rgba(): Float32Array;
    get size(): number;
    get endcaps(): ColormapEndcaps;
    sample(t: number): CartographicColor;
    reversed(): Colormap;
    withEndcaps(caps: ColormapEndcaps): Colormap;
    /** Straight linear unorm8, matching native to_linear_rgba_u8. */
    toLinearRgba8(): Uint8Array;
    toDisplayRgba8(): Uint8Array;
    toTexture(): {
        width: number;
        height: 1;
        format: 'rgba8unorm';
        data: Uint8Array;
    };
}
export declare function colormapFromStops(name: string, stops: readonly ColormapStop[], size?: number): Colormap;
export type ColormapProvider = (name: string) => Colormap;
/** Providers adapt application-owned palettes; no Python import or network fallback. */
export declare class ColormapRegistry {
    #private;
    constructor(builtins?: boolean);
    register(name: string, value: Colormap | (() => Colormap)): void;
    registerProvider(name: string, provider: ColormapProvider): void;
    available(): string[];
    get(name: string): Colormap;
}
export declare const OKABE_ITO: readonly string[];
export declare const CORE_COLORMAP_STOPS: Readonly<Record<string, readonly ColormapStop[]>>;
export declare const colormaps: ColormapRegistry;
/** Native utility interpolates encoded RGB bytes (distinct from linear colormap stops). */
export declare function interpolateHexColors(colors: readonly string[], size: number): string[];
export declare function elevationStopsFromHexColors(domain: readonly [number, number], colors: readonly string[], options?: {
    heightmap?: ArrayLike<number>;
    qLo?: number;
    qHi?: number;
}): [number, string][];
