import { Forge3DError } from "./index.js";
import type {
  AovName,
  ExrChannelInput,
  ExrCompression,
  ExrImage,
  ExrReadOptions,
  ExrWriteOptions,
  HdrTonemapOptions,
  PngEncodeOptions,
} from "./index.js";
import { loadOfflineWasm } from "./runtime-internals.js";

/** OpenEXR media type used for every EXR `Blob`. */
export const EXR_MIME_TYPE = "image/x-exr";
/** AOV object ID written for background pixels. */
export const AOV_ID_BACKGROUND = 0;
/** AOV object ID written for terrain pixels. */
export const AOV_ID_TERRAIN = 1;
/** Scene node `n` writes AOV object ID `n + AOV_ID_SCENE_NODE_BASE`. */
export const AOV_ID_SCENE_NODE_BASE = 2;

const DEFAULT_EXR_MAX_DIMENSION = 16_384;
const DEFAULT_EXR_MAX_PIXELS = 67_108_864;

function invalid(message: string, details?: unknown): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message, details);
}

function checkDimension(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_536) {
    throw invalid(`${name} must be an integer in [1, 65536]`);
  }
  return value;
}

function expectLength(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw invalid(`${name} must have ${expected} values, got ${actual}`);
  }
}

/** AOV object ID of a scene node (`node.id + 2`). */
export function aovObjectId(nodeId: number): number {
  if (!Number.isSafeInteger(nodeId) || nodeId < 0) {
    throw invalid("nodeId must be a non-negative integer");
  }
  return nodeId + AOV_ID_SCENE_NODE_BASE;
}

/** Tight RGBA8 frame, rows top to bottom (native `Frame`). */
export class Frame {
  readonly width: number;
  readonly height: number;
  readonly format = "rgba8unorm" as const;
  readonly #data: Uint8Array;

  constructor(width: number, height: number, data: Uint8Array) {
    this.width = checkDimension("width", width);
    this.height = checkDimension("height", height);
    if (!(data instanceof Uint8Array)) {
      throw invalid("Frame data must be a Uint8Array");
    }
    expectLength("Frame data", data.length, width * height * 4);
    this.#data = data.slice();
  }

  /** Read-only view of the RGBA8 pixels; use `toRgba8()` for a copy. */
  get data(): Uint8Array {
    return this.#data;
  }

  size(): [number, number] {
    return [this.width, this.height];
  }

  toRgba8(): Uint8Array {
    return this.#data.slice();
  }

  pixel(x: number, y: number): [number, number, number, number] {
    const index = pixelIndex(this.width, this.height, x, y) * 4;
    return [
      this.#data[index] ?? 0,
      this.#data[index + 1] ?? 0,
      this.#data[index + 2] ?? 0,
      this.#data[index + 3] ?? 0,
    ];
  }

  /** Deterministic PNG (native `save_png_deterministic`). */
  toPng(options: PngEncodeOptions = {}): Promise<Blob> {
    return encodePng(this.width, this.height, this.#data, options);
  }

  toString(): string {
    return `Frame(${this.width}x${this.height}, rgba8unorm)`;
  }
}

/** Linear float RGBA frame (native `HdrFrame`). */
export class HdrFrame {
  readonly width: number;
  readonly height: number;
  readonly #data: Float32Array;

  constructor(width: number, height: number, data: Float32Array) {
    this.width = checkDimension("width", width);
    this.height = checkDimension("height", height);
    if (!(data instanceof Float32Array)) {
      throw invalid("HdrFrame data must be a Float32Array");
    }
    expectLength("HdrFrame data", data.length, width * height * 4);
    this.#data = data.slice();
  }

  get size(): [number, number] {
    return [this.width, this.height];
  }

  /** Read-only view of the RGBA float pixels; `toFloat32()` copies. */
  get data(): Float32Array {
    return this.#data;
  }

  toFloat32(): Float32Array {
    return this.#data.slice();
  }

  pixel(x: number, y: number): [number, number, number, number] {
    const index = pixelIndex(this.width, this.height, x, y) * 4;
    return [
      this.#data[index] ?? 0,
      this.#data[index + 1] ?? 0,
      this.#data[index + 2] ?? 0,
      this.#data[index + 3] ?? 0,
    ];
  }

  /** CPU tonemap to RGBA8 with the native operators (WASM). */
  async tonemap(options: HdrTonemapOptions = {}): Promise<Frame> {
    const wasm = await loadOfflineWasm();
    const input: Record<string, unknown> = {
      width: this.width,
      height: this.height,
      color: this.#data,
      operator: options.operator ?? "display",
      whitePoint: options.whitePoint ?? 4,
    };
    if (options.displayEncode !== undefined) {
      expectLength("displayEncode", options.displayEncode.length, this.width * this.height);
      input.displayEncode = options.displayEncode;
    }
    try {
      return new Frame(this.width, this.height, wasm.tonemapHdr(input));
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  /** EXR `Blob` with native `beauty.R/G/B/A` channel names. */
  async toExr(options: ExrWriteOptions = {}): Promise<Blob> {
    const channels = await planarExrChannels(options.prefix ?? "beauty", this.#data, 4, this.width * this.height);
    return writeExr({
      width: this.width,
      height: this.height,
      channels,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(options.compression === undefined ? {} : { compression: options.compression }),
    });
  }

  /** Reads an RGBA (or RGB) EXR written with `prefix` channel names. */
  static async fromExr(
    source: Blob | ArrayBuffer | Uint8Array,
    options: ExrReadOptions & { prefix?: string } = {},
  ): Promise<HdrFrame> {
    const image = await readExr(source, options);
    const prefix = options.prefix ?? "beauty";
    const pixels = image.width * image.height;
    const data = new Float32Array(pixels * 4);
    const lanes = ["R", "G", "B", "A"];
    for (const [lane, suffix] of lanes.entries()) {
      const channel = image.channels.find((entry) => entry.name === `${prefix}.${suffix}`);
      if (channel === undefined) {
        if (suffix === "A") {
          for (let i = 0; i < pixels; i += 1) data[i * 4 + 3] = 1;
          continue;
        }
        throw invalid(`EXR has no ${prefix}.${suffix} channel`, {
          channels: image.channels.map((entry) => entry.name),
        });
      }
      for (let i = 0; i < pixels; i += 1) {
        data[i * 4 + lane] = Number(channel.data[i]);
      }
    }
    return new HdrFrame(image.width, image.height, data);
  }

  toString(): string {
    return `HdrFrame(${this.width}x${this.height}, rgba32float)`;
  }
}

export interface AovFrameInit {
  width: number;
  height: number;
  near: number;
  far: number;
  albedo?: Float32Array;
  normal?: Float32Array;
  depth?: Float32Array;
  id?: Uint32Array;
  motion?: Float32Array;
}

/**
 * Arbitrary output variables (native `AovFrame`): linear albedo RGB,
 * world-space shading normal XYZ, linear view depth normalized to
 * `[0, 1]` by the camera clip planes, object IDs and pixel motion.
 */
export class AovFrame {
  readonly width: number;
  readonly height: number;
  readonly near: number;
  readonly far: number;
  readonly #albedo: Float32Array | undefined;
  readonly #normal: Float32Array | undefined;
  readonly #depth: Float32Array | undefined;
  readonly #id: Uint32Array | undefined;
  readonly #motion: Float32Array | undefined;

  constructor(init: AovFrameInit) {
    this.width = checkDimension("width", init.width);
    this.height = checkDimension("height", init.height);
    if (!Number.isFinite(init.near) || !Number.isFinite(init.far) || init.far <= init.near) {
      throw invalid("AovFrame near/far must be finite with far > near");
    }
    this.near = init.near;
    this.far = init.far;
    const pixels = this.width * this.height;
    this.#albedo = checked("albedo", init.albedo, Float32Array, pixels * 3);
    this.#normal = checked("normal", init.normal, Float32Array, pixels * 3);
    this.#depth = checked("depth", init.depth, Float32Array, pixels);
    this.#id = checked("id", init.id, Uint32Array, pixels);
    this.#motion = checked("motion", init.motion, Float32Array, pixels * 2);
  }

  size(): [number, number] {
    return [this.width, this.height];
  }

  get hasAlbedo(): boolean {
    return this.#albedo !== undefined;
  }

  get hasNormal(): boolean {
    return this.#normal !== undefined;
  }

  get hasDepth(): boolean {
    return this.#depth !== undefined;
  }

  get hasId(): boolean {
    return this.#id !== undefined;
  }

  get hasMotion(): boolean {
    return this.#motion !== undefined;
  }

  /** AOV names present in this frame. */
  channels(): AovName[] {
    const names: AovName[] = [];
    if (this.hasAlbedo) names.push("albedo");
    if (this.hasNormal) names.push("normal");
    if (this.hasDepth) names.push("depth");
    if (this.hasId) names.push("id");
    if (this.hasMotion) names.push("motion");
    return names;
  }

  albedo(): Float32Array {
    return required("Albedo", this.#albedo).slice();
  }

  normal(): Float32Array {
    return required("Normal", this.#normal).slice();
  }

  depth(): Float32Array {
    return required("Depth", this.#depth).slice();
  }

  /** View-space depth `near + depth * (far - near)`; background is `far`. */
  linearDepth(): Float32Array {
    const depth = required("Depth", this.#depth);
    const span = this.far - this.near;
    return Float32Array.from(depth, (value) => this.near + value * span);
  }

  id(): Uint32Array {
    return required("Id", this.#id).slice();
  }

  /** Pixel motion `current - previous` (+x right, +y down), two lanes. */
  motion(): Float32Array {
    return required("Motion", this.#motion).slice();
  }

  /**
   * 8-bit previews (native `save_all`): albedo clamped, normals remapped
   * `n * 0.5 + 0.5`, depth as gray; keyed `${baseName}_${aov}.png`.
   */
  async toPngs(baseName = "aov", options: PngEncodeOptions = {}): Promise<Record<string, Blob>> {
    const pixels = this.width * this.height;
    const output: Record<string, Blob> = {};
    const encode = async (name: string, rgba: Uint8Array) => {
      output[`${baseName}_${name}.png`] = await encodePng(this.width, this.height, rgba, options);
    };
    if (this.#albedo !== undefined) {
      await encode("albedo", rgbToRgba8(this.#albedo, pixels, (v) => v));
    }
    if (this.#normal !== undefined) {
      await encode("normal", rgbToRgba8(this.#normal, pixels, (v) => v * 0.5 + 0.5));
    }
    if (this.#depth !== undefined) {
      const rgba = new Uint8Array(pixels * 4);
      for (let i = 0; i < pixels; i += 1) {
        const gray = toUnorm8(this.#depth[i] ?? 0);
        rgba.set([gray, gray, gray, 255], i * 4);
      }
      await encode("depth", rgba);
    }
    return output;
  }

  /**
   * Multichannel EXR (native `save_exr`): optional `beauty.RGBA`, then
   * `albedo.RGB`, `normal.XYZ`, `depth.Z`, `id` (uint) and `motion.XY`.
   */
  async toExr(beauty?: HdrFrame | Frame, options: ExrWriteOptions = {}): Promise<Blob> {
    const pixels = this.width * this.height;
    const channels: ExrChannelInput[] = [];
    if (beauty !== undefined) {
      if (beauty.width !== this.width || beauty.height !== this.height) {
        throw invalid("beauty frame size must match the AOV frame");
      }
      const data =
        beauty instanceof HdrFrame
          ? beauty.data
          : Float32Array.from(beauty.data, (value) => value / 255);
      channels.push(...(await planarExrChannels("beauty", data, 4, pixels)));
    }
    if (this.#albedo !== undefined) {
      channels.push(...(await planarExrChannels("albedo", this.#albedo, 3, pixels)));
    }
    if (this.#normal !== undefined) {
      channels.push(...(await planarExrChannels("normal", this.#normal, 3, pixels)));
    }
    if (this.#depth !== undefined) {
      channels.push(...(await planarExrChannels("depth", this.#depth, 1, pixels)));
    }
    if (this.#id !== undefined) {
      channels.push({ name: "id", data: this.#id });
    }
    if (this.#motion !== undefined) {
      channels.push(...(await planarExrChannels("motion", this.#motion, 2, pixels)));
    }
    if (channels.length === 0) {
      throw invalid("AovFrame has no channels to write");
    }
    return writeExr({
      width: this.width,
      height: this.height,
      channels,
      metadata: {
        "forge3d:near": String(this.near),
        "forge3d:far": String(this.far),
        ...(options.metadata ?? {}),
      },
      ...(options.compression === undefined ? {} : { compression: options.compression }),
    });
  }

  toString(): string {
    return `AovFrame(${this.width}x${this.height}, [${this.channels().join(", ")}])`;
  }
}

function checked<T extends Float32Array | Uint32Array>(
  name: string,
  value: T | undefined,
  type: { new (...args: never[]): T },
  length: number,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(value instanceof type)) {
    throw invalid(`AovFrame.${name} has the wrong array type`);
  }
  expectLength(`AovFrame.${name}`, value.length, length);
  return value.slice() as T;
}

function required<T>(name: string, value: T | undefined): T {
  if (value === undefined) {
    throw invalid(`${name} AOV not available`);
  }
  return value;
}

function pixelIndex(width: number, height: number, x: number, y: number): number {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw invalid(`pixel (${x}, ${y}) is outside ${width}x${height}`);
  }
  return y * width + x;
}

function toUnorm8(value: number): number {
  return Math.floor(Math.min(Math.max(value, 0), 1) * 255 + 0.5);
}

function rgbToRgba8(values: Float32Array, pixels: number, map: (value: number) => number): Uint8Array {
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    rgba[i * 4] = toUnorm8(map(values[i * 3] ?? 0));
    rgba[i * 4 + 1] = toUnorm8(map(values[i * 3 + 1] ?? 0));
    rgba[i * 4 + 2] = toUnorm8(map(values[i * 3 + 2] ?? 0));
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

async function planarExrChannels(
  prefix: string,
  interleaved: Float32Array,
  lanes: number,
  pixels: number,
): Promise<ExrChannelInput[]> {
  const wasm = await loadOfflineWasm();
  let names: string[];
  try {
    names = wasm.exrChannelNames(prefix, lanes);
  } catch (error) {
    throw Forge3DError.from(error);
  }
  return names.map((name, lane) => {
    const data = new Float32Array(pixels);
    for (let i = 0; i < pixels; i += 1) {
      data[i] = interleaved[i * lanes + lane] ?? 0;
    }
    return { name, data };
  });
}

/** Writes an EXR `Blob` from planar channels (native channel conventions). */
export async function writeExr(image: {
  width: number;
  height: number;
  channels: readonly ExrChannelInput[];
  metadata?: Readonly<Record<string, string>>;
  compression?: ExrCompression;
}): Promise<Blob> {
  const wasm = await loadOfflineWasm();
  try {
    const bytes = wasm.encodeExr({
      width: image.width,
      height: image.height,
      channels: image.channels.map((channel) => ({
        name: channel.name,
        data: channel.data,
        quantizeLinearly: channel.quantizeLinearly ?? true,
      })),
      metadata: image.metadata ?? {},
      compression: image.compression ?? "zip",
    });
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: EXR_MIME_TYPE });
  } catch (error) {
    throw Forge3DError.from(error);
  }
}

async function sourceBytes(source: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  throw invalid("EXR source must be a Blob, ArrayBuffer or Uint8Array");
}

/** Decodes an EXR after bounded header validation (typed errors). */
export async function readExr(
  source: Blob | ArrayBuffer | Uint8Array,
  options: ExrReadOptions = {},
): Promise<ExrImage> {
  const bytes = await sourceBytes(source);
  const wasm = await loadOfflineWasm();
  try {
    return wasm.decodeExr(
      bytes,
      options.maxDimension ?? DEFAULT_EXR_MAX_DIMENSION,
      options.maxPixels ?? DEFAULT_EXR_MAX_PIXELS,
    ) as ExrImage;
  } catch (error) {
    throw Forge3DError.from(error);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + (bytes[i] ?? 0)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function storedZlib(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  for (let block = 0; block < blocks; block += 1) {
    const start = block * 65535;
    const length = Math.min(65535, raw.length - start);
    out[offset] = block === blocks - 1 ? 1 : 0;
    out[offset + 1] = length & 0xff;
    out[offset + 2] = length >>> 8;
    out[offset + 3] = ~length & 0xff;
    out[offset + 4] = (~length >>> 8) & 0xff;
    out.set(raw.subarray(start, start + length), offset + 5);
    offset += 5 + length;
  }
  new DataView(out.buffer).setUint32(offset, adler32(raw));
  return out;
}

async function deflateZlib(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encodes RGBA8 pixels as a deterministic PNG (filter 0, no ancillary
 * chunks, exact alpha). `deflate` uses `CompressionStream` when available;
 * `none` writes stored zlib blocks that are byte-identical everywhere.
 */
export async function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
  options: PngEncodeOptions = {},
): Promise<Blob> {
  checkDimension("width", width);
  checkDimension("height", height);
  expectLength("PNG pixels", rgba.length, width * height * 4);
  const compression = options.compression ?? "deflate";
  if (compression !== "deflate" && compression !== "none") {
    throw invalid("PNG compression must be 'deflate' or 'none'");
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const zlib =
    compression === "deflate" && typeof CompressionStream !== "undefined"
      ? await deflateZlib(raw)
      : storedZlib(raw);
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))];
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: "image/png" });
}
