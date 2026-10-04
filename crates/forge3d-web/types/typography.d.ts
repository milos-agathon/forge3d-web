import type { LabelDiagnostic, TypographyInput, ShapedText } from "./label-types.js";
export interface FontSource {
    id: string;
    data?: ArrayBuffer | Uint8Array;
    url?: string | URL;
    sha256?: string;
}
export interface FontAtlasOptions {
    unicodeRange?: {
        start: number;
        end: number;
        name?: string;
    };
    fallbacks?: readonly FontFallbackRange[];
    fonts?: readonly FontSource[];
    signal?: AbortSignal;
    maxBytes?: number;
}
export declare class FontFallbackRange {
    readonly name: string;
    readonly start: number;
    readonly end: number;
    readonly fontFamily: string;
    constructor(name: string, start: number, end: number, fontFamily: string);
    covers(char: string): boolean;
    toJSON(): Record<string, unknown>;
}
export declare class FontAtlas {
    #private;
    readonly fontSize = 24;
    readonly lineHeight = 32;
    readonly baseline = 24;
    readonly coverage: FontAtlasOptions["unicodeRange"];
    readonly fallbacks: readonly FontFallbackRange[];
    readonly diagnostics: LabelDiagnostic[];
    private constructor();
    static create(options?: FontAtlasOptions): Promise<FontAtlas>;
    static defaultLatin(options?: Omit<FontAtlasOptions, "fonts">): Promise<FontAtlas>;
    static fromFont(url: string | URL, options?: Omit<FontAtlasOptions, "fonts">): Promise<FontAtlas>;
    queryFallback(character: string): FontFallbackRange | undefined;
    get disposed(): boolean;
    get fontIds(): string[];
    covers(text: string): boolean;
    fallbackFor(character: string): string | undefined;
    validateText(text: string): LabelDiagnostic[];
    memoryReport(): {
        fontBytes: number;
        fontCount: number;
        ownedNativeObjects: number;
        disposed: boolean;
    };
    shape(text: string, input?: TypographyInput): ShapedText;
    dispose(): void;
}
export declare class TypographySettings {
    readonly fontSize: number;
    readonly tracking: number;
    readonly kerning: boolean;
    readonly lineHeight: number;
    readonly wordSpacing: number;
    readonly baselineShift: number;
    readonly multiline: boolean;
    readonly callout: boolean;
    readonly calloutOffset: [number, number];
    readonly direction: TypographyInput["direction"];
    readonly language: string | undefined;
    constructor(input?: TypographyInput);
    measureText(text: string, atlas: FontAtlas): ShapedText;
    layoutLabel(text: string, anchor: [number, number, number], atlas: FontAtlas): {
        lines: string[];
        metrics: ShapedText;
        callout: {
            enabled: boolean;
            anchor: number[];
            label_anchor: number[];
            offset: number[];
        };
    };
}
