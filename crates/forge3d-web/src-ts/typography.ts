interface HbObject {
  readonly ptr: number;
}
interface HbFont extends HbObject {
  nominalGlyph(code: number): number | undefined;
  setScale(x: number, y: number): void;
  glyphToJson(glyph: number): { type: string; values: number[] }[];
}
interface HbBuffer extends HbObject {
  addText(text: string): void;
  guessSegmentProperties(): void;
  setDirection(dir: number): void;
  setLanguage(language: string): void;
  getGlyphInfos(): { codepoint: number; cluster: number }[];
  getGlyphPositions(): {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }[];
}
interface Hb {
  Blob: new (data: Uint8Array) => HbObject;
  Face: new (blob: HbObject) => HbObject & { upem: number };
  Font: new (face: HbObject) => HbFont;
  Buffer: new () => HbBuffer;
  Feature: new (tag: string, value: number) => unknown;
  Direction: Record<"LTR" | "RTL" | "TTB" | "BTT", number>;
  shape(font: HbFont, buffer: HbBuffer, features: unknown[]): void;
  dispose(object: object): void;
}
import type {
  LabelDiagnostic,
  TypographyInput,
  ShapedGlyph,
  ShapedText,
} from "./label-types.js";
import { labelCompare, labelDiagnostic } from "./label-diagnostics.js";
interface LoadedFont {
  id: string;
  blob: HbObject;
  face: HbObject & { upem: number };
  font: HbFont;
  bytes: number;
}
export interface FontSource {
  id: string;
  data?: ArrayBuffer | Uint8Array;
  url?: string | URL;
  sha256?: string;
}
export interface FontAtlasOptions {
  unicodeRange?: { start: number; end: number; name?: string };
  fallbacks?: readonly FontFallbackRange[];
  fonts?: readonly FontSource[];
  signal?: AbortSignal;
  maxBytes?: number;
}
const DEFAULT_FONTS: readonly FontSource[] = [
  {
    id: "NotoSans",
    url: new URL("../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
    sha256: "b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5",
  },
  {
    id: "NotoSansArabic",
    url: new URL("../assets/fonts/NotoSansArabic-Regular.ttf", import.meta.url),
    sha256: "ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b",
  },
  {
    id: "NotoSansDevanagari",
    url: new URL(
      "../assets/fonts/NotoSansDevanagari-Regular.ttf",
      import.meta.url,
    ),
    sha256: "385e78e6359a9d88a0f243d53b1209d7548361ba2194e2b9ec779bcaa7e8949d",
  },
];
let hbPromise: Promise<Hb> | undefined;
function loadHb(): Promise<Hb> {
  return (hbPromise ??= import("../assets/harfbuzz/index.mjs") as Promise<Hb>);
}
function validateFont(bytes: Uint8Array): void {
  if (bytes.length < 12) throw Error("Invalid font header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tag = view.getUint32(0),
    count = view.getUint16(4);
  if (
    ![0x00010000, 0x4f54544f, 0x74727565].includes(tag) ||
    count < 1 ||
    count > 2048 ||
    12 + 16 * count > bytes.length
  )
    throw Error("Invalid OpenType font directory");
  for (let i = 0; i < count; i++) {
    const pos = 12 + i * 16,
      offset = view.getUint32(pos + 8),
      length = view.getUint32(pos + 12);
    if (offset + length > bytes.length)
      throw Error("Font table is out of bounds");
  }
}
export class FontFallbackRange {
  constructor(
    readonly name: string,
    readonly start: number,
    readonly end: number,
    readonly fontFamily: string,
  ) {
    if (
      !name ||
      !fontFamily ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end > 0x10ffff ||
      start > end
    )
      throw Error("Invalid font fallback range");
  }
  covers(char: string): boolean {
    const code = char.codePointAt(0);
    return code !== undefined && code >= this.start && code <= this.end;
  }
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      start: this.start,
      end: this.end,
      font_family: this.fontFamily,
    };
  }
}
export class FontAtlas {
  readonly #hb: Hb;
  readonly #fonts: LoadedFont[];
  #disposed = false;
  readonly fontSize = 24;
  readonly lineHeight = 32;
  readonly baseline = 24;
  readonly coverage: FontAtlasOptions["unicodeRange"];
  readonly fallbacks: readonly FontFallbackRange[];
  readonly diagnostics: LabelDiagnostic[];
  private constructor(
    hb: Hb,
    fonts: LoadedFont[],
    options: FontAtlasOptions = {},
    diagnostics: LabelDiagnostic[] = [],
  ) {
    this.#hb = hb;
    this.#fonts = fonts;
    this.coverage = options.unicodeRange;
    this.fallbacks = [...(options.fallbacks ?? [])].sort(
      (a, b) =>
        a.start - b.start || a.end - b.end || labelCompare(a.name, b.name),
    );
    this.diagnostics = diagnostics;
  }
  static async create(options: FontAtlasOptions = {}): Promise<FontAtlas> {
    const fonts = options.fonts ?? DEFAULT_FONTS,
      max = options.maxBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(max) ||
      max < 1 ||
      fonts.length < 1 ||
      fonts.length > 32 ||
      new Set(fonts.map((f) => f.id)).size !== fonts.length
    )
      throw Error("Invalid FontAtlas limits or font IDs");
    if (options.unicodeRange) {
      const { start, end } = options.unicodeRange;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end > 0x10ffff ||
        start > end
      )
        throw Error("Invalid Unicode range");
    }
    options.signal?.throwIfAborted();
    const hb = await loadHb(),
      loaded: LoadedFont[] = [];
    let total = 0;
    try {
      for (const source of fonts) {
        options.signal?.throwIfAborted();
        let data: Uint8Array;
        if (source.data && source.data.byteLength > max - total)
          throw Error("FontAtlas byte budget exceeded");
        if (source.data)
          data = new Uint8Array(
            source.data instanceof Uint8Array
              ? source.data
              : source.data.slice(0),
          );
        else if (source.url) {
          const response = await fetch(source.url, {
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (!response.ok)
            throw Error(`Font fetch failed: ${response.status}`);
          const advertised = Number(
            response.headers.get("content-length") ?? 0,
          );
          if (advertised > max - total)
            throw Error("FontAtlas byte budget exceeded");
          const reader = response.body?.getReader();
          if (!reader) throw Error("Font response has no byte stream");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const result = await reader.read();
              if (result.done) break;
              size += result.value.length;
              if (size > max - total) {
                await reader.cancel();
                throw Error("FontAtlas byte budget exceeded");
              }
              chunks.push(result.value);
            }
          } finally {
            reader.releaseLock();
          }
          data = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
          }
        } else throw Error("Font source needs bytes or a URL");
        total += data.byteLength;
        if (total > max) throw Error("FontAtlas byte budget exceeded");
        validateFont(data);
        if (source.sha256) {
          const digest = new Uint8Array(
              await crypto.subtle.digest("SHA-256", data.slice().buffer),
            ),
            hex = Array.from(digest, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
          if (hex !== source.sha256) throw Error("Font integrity mismatch");
        }
        options.signal?.throwIfAborted();
        const blob = new hb.Blob(data),
          face = new hb.Face(blob),
          font = new hb.Font(face);
        if (!face.upem) {
          hb.dispose(font);
          hb.dispose(face);
          hb.dispose(blob);
          throw Error("Font has no units-per-em");
        }
        loaded.push({
          id: source.id,
          blob,
          face,
          font,
          bytes: data.byteLength,
        });
      }
      return new FontAtlas(hb, loaded, options);
    } catch (error) {
      for (const f of loaded.reverse()) {
        hb.dispose(f.font);
        hb.dispose(f.face);
        hb.dispose(f.blob);
      }
      throw error;
    }
  }
  static defaultLatin(
    options: Omit<FontAtlasOptions, "fonts"> = {},
  ): Promise<FontAtlas> {
    return FontAtlas.create({
      ...options,
      fonts: DEFAULT_FONTS.slice(0, 1),
      unicodeRange: { start: 32, end: 127, name: "Basic Latin" },
    });
  }
  static async fromFont(
    url: string | URL,
    options: Omit<FontAtlasOptions, "fonts"> = {},
  ): Promise<FontAtlas> {
    try {
      return await FontAtlas.create({
        ...options,
        fonts: [{ id: String(url), url }],
      });
    } catch (error) {
      if (
        options.signal?.aborted ||
        !(
          error instanceof TypeError ||
          (error instanceof Error && /Font fetch failed/.test(error.message))
        )
      )
        throw error;
      return new FontAtlas(await loadHb(), [], options, [
        labelDiagnostic(
          "missing_external_asset",
          { layer_type: "font_atlas", path: String(url) },
          String(url),
          null,
        ),
      ]);
    }
  }
  queryFallback(character: string): FontFallbackRange | undefined {
    this.#assert();
    return this.fallbacks.find((r) => r.covers(character));
  }
  get disposed(): boolean {
    return this.#disposed;
  }
  get fontIds(): string[] {
    this.#assert();
    return this.#fonts.map((f) => f.id);
  }
  covers(text: string): boolean {
    this.#assert();
    return Array.from(text).every(
      (c) =>
        c === "\n" ||
        c === "\r" ||
        c === "\t" ||
        c === "\u200d" ||
        c === "\u200c" ||
        ((!this.coverage ||
          (c.codePointAt(0)! >= this.coverage.start &&
            c.codePointAt(0)! <= this.coverage.end) ||
          !!this.queryFallback(c)) &&
          this.#fonts.some(
            (f) => f.font.nominalGlyph(c.codePointAt(0)!) !== undefined,
          )),
    );
  }
  fallbackFor(character: string): string | undefined {
    this.#assert();
    const code = character.codePointAt(0);
    return code === undefined
      ? undefined
      : this.#fonts.find((f) => f.font.nominalGlyph(code) !== undefined)?.id;
  }
  validateText(text: string): LabelDiagnostic[] {
    this.#assert();
    const missing = [
      ...new Set(Array.from(text).filter((c) => !this.covers(c))),
    ].sort(labelCompare);
    return missing.length
      ? [
          labelDiagnostic(
            "unicode_coverage_gap",
            { count: missing.length, missing_glyphs: missing },
            null,
            null,
          ),
        ]
      : [];
  }
  memoryReport(): {
    fontBytes: number;
    fontCount: number;
    ownedNativeObjects: number;
    disposed: boolean;
  } {
    return {
      fontBytes: this.#disposed
        ? 0
        : this.#fonts.reduce((s, f) => s + f.bytes, 0),
      fontCount: this.#disposed ? 0 : this.#fonts.length,
      ownedNativeObjects: this.#disposed ? 0 : this.#fonts.length * 3,
      disposed: this.#disposed,
    };
  }
  shape(text: string, input: TypographyInput = {}): ShapedText {
    this.#assert();
    if (text.length > 100000) throw Error("Text exceeds 100000 UTF-16 units");
    const settings = new TypographySettings(input),
      diagnostics = this.validateText(text),
      glyphs: ShapedGlyph[] = [];
    let width = 0,
      clusterBase = 0;
    const lines = (settings.multiline ? text : text.replace(/\n/g, " ")).split(
      "\n",
    );
    if (text.length > 100000) throw Error("Text exceeds 100000 UTF-16 units");
    if (diagnostics.length)
      return {
        glyphs,
        width: 0,
        height: lines.length * settings.lineHeight,
        lineCount: lines.length,
        lineHeight: settings.lineHeight,
        diagnostics,
        kerningApplied: settings.kerning,
        tracking: settings.tracking,
      };
    for (const [lineIndex, line] of lines.entries()) {
      const whole = this.#fonts.find((f) =>
        Array.from(line).every(
          (c) =>
            c === "\u200d" ||
            c === "\u200c" ||
            f.font.nominalGlyph(c.codePointAt(0)!) !== undefined,
        ),
      );
      const runs: { font: LoadedFont; text: string; start: number }[] = [];
      let index = 0;
      for (const c of Array.from(line)) {
        const font =
          whole ??
          this.#fonts.find(
            (f) => f.font.nominalGlyph(c.codePointAt(0)!) !== undefined,
          ) ??
          runs.at(-1)?.font ??
          this.#fonts[0]!;
        const last = runs.at(-1);
        if (last?.font === font) last.text += c;
        else runs.push({ font, text: c, start: index });
        index += c.length;
      }
      let pen = 0;
      for (const run of runs) {
        const buffer = new this.#hb.Buffer();
        try {
          buffer.addText(run.text);
          buffer.guessSegmentProperties();
          if (settings.direction)
            buffer.setDirection(
              this.#hb.Direction[
                settings.direction.toUpperCase() as
                  | "LTR"
                  | "RTL"
                  | "TTB"
                  | "BTT"
              ],
            );
          if (settings.language) buffer.setLanguage(settings.language);
          run.font.font.setScale(
            Math.round(settings.fontSize * 64),
            Math.round(settings.fontSize * 64),
          );
          this.#hb.shape(
            run.font.font,
            buffer,
            settings.kerning ? [] : [new this.#hb.Feature("kern", 0)],
          );
          const infos = buffer.getGlyphInfos(),
            positions = buffer.getGlyphPositions();
          for (let i = 0; i < infos.length; i++) {
            const info = infos[i]!,
              p = positions[i]!;
            const advance =
              p.xAdvance / 64 +
              (run.text[info.cluster] === " "
                ? (p.xAdvance / 64) * (settings.wordSpacing - 1)
                : 0) +
              settings.tracking;
            glyphs.push({
              glyphId: info.codepoint,
              cluster: clusterBase + run.start + info.cluster,
              fontId: run.font.id,
              x: pen + p.xOffset / 64,
              y:
                lineIndex * settings.lineHeight -
                p.yOffset / 64 -
                settings.baselineShift,
              xAdvance: advance,
              yAdvance: p.yAdvance / 64,
              path: run.font.font.glyphToJson(info.codepoint).map((c) => ({
                type: c.type,
                values: c.values.map((v) => v / 64),
              })),
            });
            pen += advance;
          }
        } finally {
          this.#hb.dispose(buffer);
        }
      }
      width = Math.max(width, pen - (glyphs.length ? settings.tracking : 0));
      clusterBase += line.length + 1;
    }
    return {
      glyphs,
      width,
      height: lines.length * settings.lineHeight,
      lineCount: lines.length,
      lineHeight: settings.lineHeight,
      diagnostics,
      kerningApplied: settings.kerning,
      tracking: settings.tracking,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const f of this.#fonts) {
      this.#hb.dispose(f.font);
      this.#hb.dispose(f.face);
      this.#hb.dispose(f.blob);
    }
    this.#fonts.length = 0;
  }
  #assert(): void {
    if (this.#disposed) throw Error("FontAtlas is disposed");
  }
}
export class TypographySettings {
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
  constructor(input: TypographyInput = {}) {
    this.fontSize = input.fontSize ?? 24;
    this.tracking = input.tracking ?? 0;
    this.kerning = input.kerning ?? true;
    this.lineHeight = input.lineHeight ?? (this.fontSize * 4) / 3;
    this.wordSpacing = input.wordSpacing ?? 1;
    this.baselineShift = input.baselineShift ?? 0;
    this.multiline = input.multiline ?? true;
    this.callout = input.callout ?? false;
    this.calloutOffset = [...(input.calloutOffset ?? [8, -4])];
    this.direction = input.direction;
    this.language = input.language;
    if (
      input.direction !== undefined &&
      !["ltr", "rtl"].includes(input.direction)
    )
      throw Error("Unsupported typography direction");
    if (
      ![
        this.fontSize,
        this.tracking,
        this.lineHeight,
        this.wordSpacing,
        this.baselineShift,
        ...this.calloutOffset,
      ].every(Number.isFinite) ||
      this.fontSize <= 0 ||
      this.fontSize > 4096 ||
      this.lineHeight <= 0 ||
      this.wordSpacing < 0
    )
      throw Error("Invalid typography metrics");
  }
  measureText(text: string, atlas: FontAtlas): ShapedText {
    return atlas.shape(text, this);
  }
  layoutLabel(
    text: string,
    anchor: [number, number, number],
    atlas: FontAtlas,
  ): {
    lines: string[];
    metrics: ShapedText;
    callout: {
      enabled: boolean;
      anchor: number[];
      label_anchor: number[];
      offset: number[];
    };
  } {
    return {
      lines: text.split("\n"),
      metrics: this.measureText(text, atlas),
      callout: {
        enabled: this.callout,
        anchor: [...anchor],
        label_anchor: [
          anchor[0] + this.calloutOffset[0],
          anchor[1] + this.calloutOffset[1],
          anchor[2],
        ],
        offset: [...this.calloutOffset],
      },
    };
  }
}
