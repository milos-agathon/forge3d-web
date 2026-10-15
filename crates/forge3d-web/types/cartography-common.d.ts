/** Straight RGBA, sRGB unless a particular API explicitly says linear. */
export type CartographicColor = readonly [number, number, number, number];
export declare const CARTOGRAPHY_MAX_BYTES: number;
export declare function cartographicError(message: string, reason?: string): never;
export declare function finite(value: number, name: string, min?: number, max?: number): number;
export declare function integer(value: number, name: string, min?: number, max?: number): number;
export declare function color(value: CartographicColor): [number, number, number, number];
export declare function css(value: CartographicColor): string;
export declare function checkBytes(bytes: number, maxBytes?: number): void;
export declare function cancelled(signal?: AbortSignal): void;
export declare function xml(value: string): string;
export declare function srgbToLinear(c: number): number;
export declare function linearToSrgb(c: number): number;
export declare function validateExportFont(bytes: Uint8Array): void;
