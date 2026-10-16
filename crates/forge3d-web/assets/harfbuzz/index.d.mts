// Forge3D interface for the pinned self-hosted HarfBuzz module.
export interface NativeObject {
  readonly ptr: number;
}
export class Blob implements NativeObject {
  readonly ptr: number;
  constructor(data: Uint8Array);
}
export class Face implements NativeObject {
  readonly ptr: number;
  readonly upem: number;
  constructor(blob: NativeObject);
}
export class Font implements NativeObject {
  readonly ptr: number;
  constructor(face: NativeObject);
  nominalGlyph(code: number): number | undefined;
  setScale(x: number, y: number): void;
  glyphToJson(glyph: number): { type: string; values: number[] }[];
}
export class Buffer implements NativeObject {
  readonly ptr: number;
  addText(text: string): void;
  guessSegmentProperties(): void;
  setDirection(direction: number): void;
  setLanguage(language: string): void;
  getGlyphInfos(): { codepoint: number; cluster: number }[];
  getGlyphPositions(): {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }[];
}
export class Feature {
  constructor(tag: string, value: number);
}
export const Direction: Record<"LTR" | "RTL" | "TTB" | "BTT", number>;
export function shape(font: Font, buffer: Buffer, features: unknown[]): void;
export function dispose(object: object): void;
