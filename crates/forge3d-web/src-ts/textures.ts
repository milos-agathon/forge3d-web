import {
  KHR_DF_MODEL_ETC1S,
  KHR_DF_MODEL_UASTC,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  KHR_SUPERCOMPRESSION_BASISLZ,
  KHR_SUPERCOMPRESSION_NONE,
  VK_FORMAT_UNDEFINED,
  read,
} from "ktx-parse";
import type { KTX2Container } from "ktx-parse";

import { readByteSource } from "./browser-io.js";
import { Forge3DError } from "./index.js";
import type {
  BasisTranscoderAdapter,
  BrowserByteSource,
  GltfMaterialChannels,
  Ktx2LoaderOptions,
  Ktx2LoadOptions,
  Ktx2TranscodeReport,
  MeshTbnInput,
  MeshTbnResult,
  TextureColorSpace,
  TextureEffectiveQuality,
  TextureFilter,
  TextureFormat,
  TextureFormatCapabilities,
  TextureImageInput,
  TextureImageSnapshot,
  TextureLevelInput,
  TextureLevelSnapshot,
  TextureSamplerConfig,
  TextureSemantic,
  TextureSetInput,
  TextureSetSnapshot,
  TextureWrapMode,
} from "./index.js";

export const MAX_TEXTURE_DIMENSION = 16384;
const DEFAULT_KTX2_MAX_BYTES = 256 * 1024 * 1024;

const SEMANTIC_KEYS = [
  "baseColor",
  "normal",
  "metallicRoughness",
  "occlusion",
  "emissive",
] as const;
type SemanticKey = (typeof SEMANTIC_KEYS)[number];

const SEMANTIC_OF_KEY: Record<SemanticKey, TextureSemantic> = {
  baseColor: "base-color",
  normal: "normal",
  metallicRoughness: "metallic-roughness",
  occlusion: "occlusion",
  emissive: "emissive",
};

const DATA_SEMANTICS: ReadonlySet<TextureSemantic> = new Set([
  "normal",
  "metallic-roughness",
  "occlusion",
]);

const COMPRESSED_BLOCK_BYTES: Partial<Record<TextureFormat, number>> = {
  "bc1-rgba-unorm": 8,
  "bc1-rgba-unorm-srgb": 8,
  "bc3-rgba-unorm": 16,
  "bc3-rgba-unorm-srgb": 16,
  "bc7-rgba-unorm": 16,
  "bc7-rgba-unorm-srgb": 16,
  "etc2-rgba8unorm": 16,
  "etc2-rgba8unorm-srgb": 16,
  "astc-4x4-unorm": 16,
  "astc-4x4-unorm-srgb": 16,
};

const TEXTURE_FORMATS: ReadonlySet<string> = new Set([
  "rgba8unorm",
  "rgba8unorm-srgb",
  ...Object.keys(COMPRESSED_BLOCK_BYTES),
]);

const WRAP_MODES: ReadonlySet<string> = new Set([
  "repeat",
  "clamp-to-edge",
  "mirror-repeat",
]);
const FILTERS: ReadonlySet<string> = new Set(["nearest", "linear"]);
const ANISOTROPY_LEVELS: ReadonlySet<number> = new Set([1, 2, 4, 8, 16]);
const SOURCE_FORMATS: ReadonlySet<string> = new Set(["raw", "ktx2", "basis"]);
const EFFECTIVE_QUALITIES: ReadonlySet<string> = new Set([
  "native",
  "transcoded",
  "rgba8-fallback",
]);

const VK_FORMAT_MAP: ReadonlyMap<number, TextureFormat> = new Map([
  [37, "rgba8unorm"],
  [43, "rgba8unorm-srgb"],
  [131, "bc1-rgba-unorm"],
  [132, "bc1-rgba-unorm-srgb"],
  [137, "bc3-rgba-unorm"],
  [138, "bc3-rgba-unorm-srgb"],
  [145, "bc7-rgba-unorm"],
  [146, "bc7-rgba-unorm-srgb"],
  [151, "etc2-rgba8unorm"],
  [152, "etc2-rgba8unorm-srgb"],
  [157, "astc-4x4-unorm"],
  [158, "astc-4x4-unorm-srgb"],
]);

const FEATURE_OF_FORMAT: Partial<Record<TextureFormat, string>> = {
  "bc1-rgba-unorm": "bc",
  "bc1-rgba-unorm-srgb": "bc",
  "bc3-rgba-unorm": "bc",
  "bc3-rgba-unorm-srgb": "bc",
  "bc7-rgba-unorm": "bc",
  "bc7-rgba-unorm-srgb": "bc",
  "etc2-rgba8unorm": "etc2",
  "etc2-rgba8unorm-srgb": "etc2",
  "astc-4x4-unorm": "astc",
  "astc-4x4-unorm-srgb": "astc",
};

function invalid(message: string, field: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message, { field });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Forge3DError("REQUEST_CANCELLED", "ktx2 load was cancelled");
  }
}

export function isCompressedTextureFormat(format: string): boolean {
  return format in COMPRESSED_BLOCK_BYTES;
}

export function isSrgbTextureFormat(format: string): boolean {
  return format.endsWith("-srgb");
}

function textureLevelByteLength(
  format: TextureFormat,
  width: number,
  height: number,
): number {
  const blockBytes = COMPRESSED_BLOCK_BYTES[format];
  if (blockBytes === undefined) {
    return width * height * 4;
  }
  return Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
}

function normalizeDimension(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TEXTURE_DIMENSION
  ) {
    throw invalid(
      `${field} must be an integer between 1 and ${MAX_TEXTURE_DIMENSION}`,
      field,
    );
  }
  return value;
}

function normalizeLevelData(value: unknown, expected: number, field: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== expected) {
      throw invalid(
        `${field} must contain exactly ${expected} bytes`,
        field,
      );
    }
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    if (value.length !== expected) {
      throw invalid(
        `${field} must contain exactly ${expected} bytes`,
        field,
      );
    }
    const data = new Uint8Array(expected);
    for (let index = 0; index < expected; index += 1) {
      const component = value[index];
      if (
        typeof component !== "number" ||
        !Number.isInteger(component) ||
        component < 0 ||
        component > 255
      ) {
        throw invalid(`${field} components must be byte values`, field);
      }
      data[index] = component;
    }
    return data;
  }
  throw invalid(`${field} must be a Uint8Array`, field);
}

function checkSemanticColorContract(
  semantic: TextureSemantic,
  format: TextureFormat,
  colorSpace: TextureColorSpace,
  field: string,
): void {
  const srgbFormat = isSrgbTextureFormat(format);
  if (DATA_SEMANTICS.has(semantic)) {
    if (colorSpace !== "linear" || srgbFormat) {
      throw invalid(
        `${field} requires linear colorSpace and a non-sRGB format`,
        field,
      );
    }
    return;
  }
  if (srgbFormat !== (colorSpace === "srgb")) {
    throw invalid(
      `${field} requires an sRGB format iff colorSpace is srgb`,
      field,
    );
  }
}

function decodeSrgb(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : Math.pow((component + 0.055) / 1.055, 2.4);
}

function encodeSrgb(component: number): number {
  return component <= 0.0031308
    ? 12.92 * component
    : 1.055 * Math.pow(component, 1 / 2.4) - 0.055;
}

function downsampleLevel(
  level: TextureLevelSnapshot,
  outWidth: number,
  outHeight: number,
  semantic: TextureSemantic,
  srgb: boolean,
): TextureLevelSnapshot {
  const { width, height, data } = level;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const yStart = Math.floor((y * height) / outHeight);
    const yEnd = Math.max(
      yStart + 1,
      Math.ceil(((y + 1) * height) / outHeight),
    );
    for (let x = 0; x < outWidth; x += 1) {
      const xStart = Math.floor((x * width) / outWidth);
      const xEnd = Math.max(
        xStart + 1,
        Math.ceil(((x + 1) * width) / outWidth),
      );
      const count = (xEnd - xStart) * (yEnd - yStart);
      const offset = (y * outWidth + x) * 4;
      if (semantic === "normal") {
        const sum = [0, 0, 0];
        for (let sy = yStart; sy < yEnd; sy += 1) {
          for (let sx = xStart; sx < xEnd; sx += 1) {
            const px = (sy * width + sx) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
              sum[channel]! += (data[px + channel]! / 255) * 2 - 1;
            }
          }
        }
        const length = Math.hypot(sum[0]!, sum[1]!, sum[2]!);
        if (length <= 1e-8) {
          out[offset] = 128;
          out[offset + 1] = 128;
          out[offset + 2] = 255;
        } else {
          for (let channel = 0; channel < 3; channel += 1) {
            const component = sum[channel]! / length;
            out[offset + channel] = Math.round(
              Math.min(255, Math.max(0, ((component + 1) / 2) * 255)),
            );
          }
        }
      } else {
        for (let channel = 0; channel < 3; channel += 1) {
          let sum = 0;
          for (let sy = yStart; sy < yEnd; sy += 1) {
            for (let sx = xStart; sx < xEnd; sx += 1) {
              const component = data[(sy * width + sx) * 4 + channel]! / 255;
              sum += srgb ? decodeSrgb(component) : component;
            }
          }
          const average = sum / count;
          const encoded = srgb ? encodeSrgb(average) : average;
          out[offset + channel] = Math.round(
            Math.min(255, Math.max(0, encoded * 255)),
          );
        }
      }
      let alpha = 0;
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          alpha += data[(sy * width + sx) * 4 + 3]!;
        }
      }
      out[offset + 3] = Math.round(alpha / count);
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

function normalizeSampler(
  input: TextureSamplerConfig | undefined,
  field: string,
): Required<TextureSamplerConfig> {
  const source =
    input === undefined
      ? {}
      : typeof input === "object" && input !== null
        ? input
        : (() => {
            throw invalid(`${field} must be an object`, field);
          })();
  const wrap = (value: unknown, name: string): TextureWrapMode => {
    if (value === undefined) {
      return "repeat";
    }
    if (typeof value !== "string" || !WRAP_MODES.has(value)) {
      throw invalid(`${field}.${name} must be a valid wrap mode`, field);
    }
    return value as TextureWrapMode;
  };
  const filter = (value: unknown, name: string): TextureFilter => {
    if (value === undefined) {
      return "linear";
    }
    if (typeof value !== "string" || !FILTERS.has(value)) {
      throw invalid(`${field}.${name} must be nearest or linear`, field);
    }
    return value as TextureFilter;
  };
  const anisotropy = source.maxAnisotropy ?? 1;
  if (!ANISOTROPY_LEVELS.has(anisotropy)) {
    throw invalid(
      `${field}.maxAnisotropy must be one of 1, 2, 4, 8, 16`,
      field,
    );
  }
  const normalized: Required<TextureSamplerConfig> = {
    wrapU: wrap(source.wrapU, "wrapU"),
    wrapV: wrap(source.wrapV, "wrapV"),
    magFilter: filter(source.magFilter, "magFilter"),
    minFilter: filter(source.minFilter, "minFilter"),
    mipmapFilter: filter(source.mipmapFilter, "mipmapFilter"),
    maxAnisotropy: anisotropy as 1 | 2 | 4 | 8 | 16,
  };
  if (
    normalized.maxAnisotropy > 1 &&
    (normalized.magFilter !== "linear" ||
      normalized.minFilter !== "linear" ||
      normalized.mipmapFilter !== "linear")
  ) {
    throw invalid(
      `${field}.maxAnisotropy above 1 requires linear mag/min/mipmap filters`,
      field,
    );
  }
  return normalized;
}

function isImageSnapshot(
  value: TextureImageInput | TextureImageSnapshot,
): value is TextureImageSnapshot {
  return Array.isArray((value as TextureImageSnapshot).levels);
}

function normalizeImage(
  input: TextureImageInput | TextureImageSnapshot,
  semantic: TextureSemantic,
  field: string,
): TextureImageSnapshot {
  if (typeof input !== "object" || input === null) {
    throw invalid(`${field} must be an object`, field);
  }
  const width = normalizeDimension(input.width, `${field}.width`);
  const height = normalizeDimension(input.height, `${field}.height`);
  const format = input.format;
  if (typeof format !== "string" || !TEXTURE_FORMATS.has(format)) {
    throw invalid(`${field}.format is not a supported texture format`, field);
  }
  const colorSpace = input.colorSpace;
  if (colorSpace !== "srgb" && colorSpace !== "linear") {
    throw invalid(`${field}.colorSpace must be srgb or linear`, field);
  }
  checkSemanticColorContract(semantic, format, colorSpace, field);
  const compressed = isCompressedTextureFormat(format);
  const srgb = isSrgbTextureFormat(format);

  let suppliedMipmaps: TextureLevelInput[];
  let baseData: Uint8Array;
  let sourceFormat: "raw" | "ktx2" | "basis";
  let effectiveQuality: TextureEffectiveQuality;
  let generateMipmaps: boolean;
  if (isImageSnapshot(input)) {
    if (!Array.isArray(input.levels) || input.levels.length === 0) {
      throw invalid(`${field}.levels must contain the base level`, field);
    }
    const base = input.levels[0]!;
    if (base.width !== width || base.height !== height) {
      throw invalid(
        `${field}.levels[0] must match the image dimensions`,
        field,
      );
    }
    baseData = base.data;
    suppliedMipmaps = input.levels.slice(1).map((level) => ({
      width: level.width,
      height: level.height,
      data: level.data,
    }));
    if (
      typeof input.compressed !== "boolean" ||
      input.compressed !== compressed
    ) {
      throw invalid(`${field}.compressed does not match the format`, field);
    }
    if (
      typeof input.sourceFormat !== "string" ||
      !SOURCE_FORMATS.has(input.sourceFormat)
    ) {
      throw invalid(`${field}.sourceFormat is invalid`, field);
    }
    if (
      typeof input.effectiveQuality !== "string" ||
      !EFFECTIVE_QUALITIES.has(input.effectiveQuality)
    ) {
      throw invalid(`${field}.effectiveQuality is invalid`, field);
    }
    const expectedQuality =
      input.sourceFormat === "basis"
        ? compressed
          ? "transcoded"
          : format === "rgba8unorm" || format === "rgba8unorm-srgb"
            ? "rgba8-fallback"
            : undefined
        : "native";
    if (
      expectedQuality === undefined ||
      input.effectiveQuality !== expectedQuality
    ) {
      throw invalid(
        `${field}.effectiveQuality ${input.effectiveQuality} is inconsistent with sourceFormat ${input.sourceFormat} and format ${format}`,
        field,
      );
    }
    sourceFormat = input.sourceFormat;
    effectiveQuality = input.effectiveQuality;
    generateMipmaps = false;
  } else {
    baseData = input.data;
    suppliedMipmaps = input.mipmaps ?? [];
    sourceFormat = input.sourceFormat ?? "raw";
    effectiveQuality = input.effectiveQuality ?? "native";
    generateMipmaps = input.generateMipmaps ?? false;
    if (sourceFormat !== "raw") {
      throw invalid(
        `${field}.sourceFormat must be raw for direct input`,
        field,
      );
    }
    if (effectiveQuality !== "native") {
      throw invalid(
        `${field}.effectiveQuality must be native for direct input`,
        field,
      );
    }
  }
  if (!Array.isArray(suppliedMipmaps)) {
    throw invalid(`${field}.mipmaps must be an array`, field);
  }

  const levels: TextureLevelSnapshot[] = [
    {
      width,
      height,
      data: normalizeLevelData(
        baseData,
        textureLevelByteLength(format, width, height),
        `${field}.data`,
      ),
    },
  ];
  for (const [mipIndex, level] of suppliedMipmaps.entries()) {
    const previous = levels[levels.length - 1]!;
    const expectedWidth = Math.max(1, Math.floor(previous.width / 2));
    const expectedHeight = Math.max(1, Math.floor(previous.height / 2));
    const levelWidth = normalizeDimension(
      level.width,
      `${field}.mipmaps[${mipIndex}].width`,
    );
    const levelHeight = normalizeDimension(
      level.height,
      `${field}.mipmaps[${mipIndex}].height`,
    );
    if (levelWidth !== expectedWidth || levelHeight !== expectedHeight) {
      throw invalid(
        `${field}.mipmaps[${mipIndex}] must be exactly ${expectedWidth}x${expectedHeight}`,
        field,
      );
    }
    levels.push({
      width: levelWidth,
      height: levelHeight,
      data: normalizeLevelData(
        level.data,
        textureLevelByteLength(format, levelWidth, levelHeight),
        `${field}.mipmaps[${mipIndex}].data`,
      ),
    });
  }
  if (generateMipmaps) {
    if (compressed) {
      throw invalid(
        `${field}.generateMipmaps is not supported for compressed formats`,
        field,
      );
    }
    let last = levels[levels.length - 1]!;
    while (last.width > 1 || last.height > 1) {
      const next = downsampleLevel(
        last,
        Math.max(1, Math.floor(last.width / 2)),
        Math.max(1, Math.floor(last.height / 2)),
        semantic,
        srgb,
      );
      levels.push(next);
      last = next;
    }
  }
  return {
    width,
    height,
    format,
    colorSpace,
    levels,
    compressed,
    sourceFormat,
    effectiveQuality,
  };
}

function cloneImage(image: TextureImageSnapshot): TextureImageSnapshot {
  return {
    width: image.width,
    height: image.height,
    format: image.format,
    colorSpace: image.colorSpace,
    levels: image.levels.map((level) => ({
      width: level.width,
      height: level.height,
      data: new Uint8Array(level.data),
    })),
    compressed: image.compressed,
    sourceFormat: image.sourceFormat,
    effectiveQuality: image.effectiveQuality,
  };
}

export class TextureSet {
  readonly #images = new Map<SemanticKey, TextureImageSnapshot>();
  readonly #sampler: Required<TextureSamplerConfig>;

  constructor(input?: TextureSetInput) {
    const source =
      input === undefined
        ? {}
        : typeof input === "object" && input !== null
          ? input
          : (() => {
              throw invalid(
                "material.textures must be an object",
                "material.textures",
              );
            })();
    this.#sampler = normalizeSampler(source.sampler, "material.textures.sampler");
    for (const key of SEMANTIC_KEYS) {
      const image = source[key];
      if (image === undefined) {
        continue;
      }
      this.#images.set(
        key,
        normalizeImage(image, SEMANTIC_OF_KEY[key], `material.textures.${key}`),
      );
    }
  }

  static from(snapshot: TextureSetSnapshot): TextureSet {
    if (typeof snapshot !== "object" || snapshot === null) {
      throw invalid("material.textures must be an object", "material.textures");
    }
    const input: TextureSetInput = { sampler: snapshot.sampler };
    for (const key of SEMANTIC_KEYS) {
      const image = snapshot[key];
      if (image !== undefined) {
        input[key] = image;
      }
    }
    return new TextureSet(input);
  }

  get(semantic: TextureSemantic): TextureImageSnapshot | undefined {
    for (const key of SEMANTIC_KEYS) {
      if (SEMANTIC_OF_KEY[key] === semantic) {
        const image = this.#images.get(key);
        return image === undefined ? undefined : cloneImage(image);
      }
    }
    throw invalid(`unknown texture semantic '${semantic}'`, "semantic");
  }

  snapshot(): TextureSetSnapshot {
    const snapshot: TextureSetSnapshot = { sampler: { ...this.#sampler } };
    for (const key of SEMANTIC_KEYS) {
      const image = this.#images.get(key);
      if (image !== undefined) {
        snapshot[key] = cloneImage(image);
      }
    }
    return snapshot;
  }

  copy(): TextureSet {
    return TextureSet.from(this.snapshot());
  }

  estimatedGpuBytes(): number {
    let total = 0;
    for (const image of this.#images.values()) {
      for (const level of image.levels) {
        total += level.data.byteLength;
        if (!Number.isSafeInteger(total)) {
          throw invalid(
            "material texture payload exceeds safe integer range",
            "material.textures",
          );
        }
      }
    }
    return total;
  }
}

export function textureSetSnapshotGpuBytes(
  snapshot: TextureSetSnapshot,
): number {
  let total = 0;
  for (const key of SEMANTIC_KEYS) {
    const image = snapshot[key];
    if (image === undefined) {
      continue;
    }
    for (const level of image.levels) {
      total += level.data.byteLength;
    }
  }
  return total;
}

export function textureSetsEqual(
  a: TextureSetSnapshot,
  b: TextureSetSnapshot,
): boolean {
  const samplerA = a.sampler;
  const samplerB = b.sampler;
  if (
    typeof samplerA !== "object" ||
    samplerA === null ||
    typeof samplerB !== "object" ||
    samplerB === null ||
    samplerA.wrapU !== samplerB.wrapU ||
    samplerA.wrapV !== samplerB.wrapV ||
    samplerA.magFilter !== samplerB.magFilter ||
    samplerA.minFilter !== samplerB.minFilter ||
    samplerA.mipmapFilter !== samplerB.mipmapFilter ||
    samplerA.maxAnisotropy !== samplerB.maxAnisotropy
  ) {
    return false;
  }
  for (const key of SEMANTIC_KEYS) {
    const imageA = a[key];
    const imageB = b[key];
    if ((imageA === undefined) !== (imageB === undefined)) {
      return false;
    }
    if (imageA === undefined || imageB === undefined) {
      continue;
    }
    if (
      imageA.width !== imageB.width ||
      imageA.height !== imageB.height ||
      imageA.format !== imageB.format ||
      imageA.colorSpace !== imageB.colorSpace ||
      imageA.compressed !== imageB.compressed ||
      imageA.sourceFormat !== imageB.sourceFormat ||
      imageA.effectiveQuality !== imageB.effectiveQuality ||
      imageA.levels.length !== imageB.levels.length
    ) {
      return false;
    }
    for (let level = 0; level < imageA.levels.length; level += 1) {
      const levelA = imageA.levels[level]!;
      const levelB = imageB.levels[level]!;
      if (
        levelA.width !== levelB.width ||
        levelA.height !== levelB.height ||
        levelA.data.byteLength !== levelB.data.byteLength
      ) {
        return false;
      }
      for (let byte = 0; byte < levelA.data.byteLength; byte += 1) {
        if (levelA.data[byte] !== levelB.data[byte]) {
          return false;
        }
      }
    }
  }
  return true;
}

export function generateMeshTangents(input: MeshTbnInput): MeshTbnResult {
  if (typeof input !== "object" || input === null) {
    throw invalid("mesh input must be an object", "mesh");
  }
  const positions = input.positions;
  const normals = input.normals;
  const uvs = input.uvs;
  const indices = input.indices;
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0 || positions.length === 0) {
    throw invalid(
      "mesh.positions must contain a nonzero multiple of 3 floats",
      "mesh.positions",
    );
  }
  const vertexCount = positions.length / 3;
  if (!(normals instanceof Float32Array) || normals.length !== positions.length) {
    throw invalid(
      "mesh.normals must contain exactly one normal per position",
      "mesh.normals",
    );
  }
  if (!(uvs instanceof Float32Array) || uvs.length !== vertexCount * 2) {
    throw invalid(
      "mesh.uvs must contain exactly one uv pair per position",
      "mesh.uvs",
    );
  }
  if (
    !(indices instanceof Uint16Array) &&
    !(indices instanceof Uint32Array)
  ) {
    throw invalid(
      "mesh.indices must be a Uint16Array or Uint32Array",
      "mesh.indices",
    );
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw invalid(
      "mesh.indices must contain a nonzero multiple of 3 indices",
      "mesh.indices",
    );
  }
  for (const index of indices) {
    if (index >= vertexCount) {
      throw invalid(
        `mesh.indices index ${index} exceeds vertex count ${vertexCount}`,
        "mesh.indices",
      );
    }
  }
  for (const [field, components] of [
    ["mesh.positions", positions],
    ["mesh.normals", normals],
    ["mesh.uvs", uvs],
  ] as const) {
    for (const component of components) {
      if (!Number.isFinite(component)) {
        throw invalid(`${field} components must be finite`, field);
      }
    }
  }

  const tangentX = new Float64Array(vertexCount);
  const tangentY = new Float64Array(vertexCount);
  const tangentZ = new Float64Array(vertexCount);
  const bitangentX = new Float64Array(vertexCount);
  const bitangentY = new Float64Array(vertexCount);
  const bitangentZ = new Float64Array(vertexCount);
  for (let tri = 0; tri < indices.length; tri += 3) {
    const a = indices[tri]!;
    const b = indices[tri + 1]!;
    const c = indices[tri + 2]!;
    const p0x = positions[a * 3]!;
    const p0y = positions[a * 3 + 1]!;
    const p0z = positions[a * 3 + 2]!;
    const e1x = positions[b * 3]! - p0x;
    const e1y = positions[b * 3 + 1]! - p0y;
    const e1z = positions[b * 3 + 2]! - p0z;
    const e2x = positions[c * 3]! - p0x;
    const e2y = positions[c * 3 + 1]! - p0y;
    const e2z = positions[c * 3 + 2]! - p0z;
    const duv1x = uvs[b * 2]! - uvs[a * 2]!;
    const duv1y = uvs[b * 2 + 1]! - uvs[a * 2 + 1]!;
    const duv2x = uvs[c * 2]! - uvs[a * 2]!;
    const duv2y = uvs[c * 2 + 1]! - uvs[a * 2 + 1]!;
    const det = duv1x * duv2y - duv2x * duv1y;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      continue;
    }
    const area =
      0.5 *
      Math.hypot(
        e1y * e2z - e1z * e2y,
        e1z * e2x - e1x * e2z,
        e1x * e2y - e1y * e2x,
      );
    if (!Number.isFinite(area) || area <= 0) {
      continue;
    }
    const invDet = 1 / det;
    const tx = (e1x * duv2y - e2x * duv1y) * invDet * area;
    const ty = (e1y * duv2y - e2y * duv1y) * invDet * area;
    const tz = (e1z * duv2y - e2z * duv1y) * invDet * area;
    const bx = (e2x * duv1x - e1x * duv2x) * invDet * area;
    const by = (e2y * duv1x - e1y * duv2x) * invDet * area;
    const bz = (e2z * duv1x - e1z * duv2x) * invDet * area;
    for (const vertex of [a, b, c]) {
      tangentX[vertex]! += tx;
      tangentY[vertex]! += ty;
      tangentZ[vertex]! += tz;
      bitangentX[vertex]! += bx;
      bitangentY[vertex]! += by;
      bitangentZ[vertex]! += bz;
    }
  }

  const tangents = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    let nx = normals[vertex * 3]!;
    let ny = normals[vertex * 3 + 1]!;
    let nz = normals[vertex * 3 + 2]!;
    const nLength = Math.hypot(nx, ny, nz);
    if (Number.isFinite(nLength) && nLength > 1e-6) {
      nx /= nLength;
      ny /= nLength;
      nz /= nLength;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }
    let tx = tangentX[vertex]! - nx * (nx * tangentX[vertex]! + ny * tangentY[vertex]! + nz * tangentZ[vertex]!);
    let ty = tangentY[vertex]! - ny * (nx * tangentX[vertex]! + ny * tangentY[vertex]! + nz * tangentZ[vertex]!);
    let tz = tangentZ[vertex]! - nz * (nx * tangentX[vertex]! + ny * tangentY[vertex]! + nz * tangentZ[vertex]!);
    let tLength = Math.hypot(tx, ty, tz);
    if (!Number.isFinite(tLength) || tLength < 1e-6) {
      const ax = Math.abs(nx) < 0.9 ? 1 : 0;
      const ay = ax === 1 ? 0 : 1;
      tx = ax - nx * (nx * ax + ny * ay);
      ty = ay - ny * (nx * ax + ny * ay);
      tz = -nz * (nx * ax + ny * ay);
      tLength = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= tLength;
    ty /= tLength;
    tz /= tLength;
    const handedness =
      (ny * tz - nz * ty) * bitangentX[vertex]! +
      (nz * tx - nx * tz) * bitangentY[vertex]! +
      (nx * ty - ny * tx) * bitangentZ[vertex]!;
    const offset = vertex * 4;
    tangents[offset] = tx;
    tangents[offset + 1] = ty;
    tangents[offset + 2] = tz;
    tangents[offset + 3] = handedness < 0 ? -1 : 1;
  }
  return { tangents };
}

export function extractGltfMaterialChannels(
  data: Uint8Array,
  width: number,
  height: number,
): GltfMaterialChannels {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_TEXTURE_DIMENSION ||
    height > MAX_TEXTURE_DIMENSION
  ) {
    throw invalid(
      "gltf material extraction requires integer dimensions between 1 and 16384",
      "width",
    );
  }
  const pixels = width * height;
  const expected = pixels * 4;
  if (!(data instanceof Uint8Array) || data.byteLength !== expected) {
    throw invalid(
      `gltf material data must be exactly ${expected} bytes of RGBA8`,
      "data",
    );
  }
  const occlusion = new Uint8Array(pixels);
  const roughness = new Uint8Array(pixels);
  const metallic = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    occlusion[index] = data[offset]!;
    roughness[index] = data[offset + 1]!;
    metallic[index] = data[offset + 2]!;
  }
  return { occlusion, roughness, metallic };
}

interface BasisModule {
  KTX2File: new (data: Uint8Array) => BasisKtx2File;
  transcoder_texture_format: Record<string, unknown>;
}

interface BasisKtx2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getLayers?(): number;
  getFaces?(): number;
  startTranscoding(): unknown;
  getImageTranscodedSizeInBytes(
    level: number,
    layer: number,
    face: number,
    format: unknown,
  ): number;
  transcodeImage(
    dst: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: unknown,
    getAlphaForOpaqueFormats: number,
    channel0: number,
    channel1: number,
  ): unknown;
  close(): void;
  delete(): void;
}

const BASIS_TARGET_ENUM: Record<string, string> = {
  "bc7-rgba-unorm": "cTFBC7_RGBA",
  "bc7-rgba-unorm-srgb": "cTFBC7_RGBA",
  "astc-4x4-unorm": "cTFASTC_4x4_RGBA",
  "astc-4x4-unorm-srgb": "cTFASTC_4x4_RGBA",
  "etc2-rgba8unorm": "cTFETC2_RGBA",
  "etc2-rgba8unorm-srgb": "cTFETC2_RGBA",
  rgba8unorm: "cTFRGBA32",
  "rgba8unorm-srgb": "cTFRGBA32",
};

const BASIS_MODULE_KEY = Symbol.for("forge3d.basisTranscoderModules");

interface BasisModuleStore {
  modules: Map<string, Promise<BasisModule>>;
  tail: Promise<void>;
}

function basisModuleStore(): BasisModuleStore {
  const scope = globalThis as unknown as Record<
    symbol,
    BasisModuleStore | undefined
  >;
  let store = scope[BASIS_MODULE_KEY];
  if (store === undefined) {
    store = { modules: new Map(), tail: Promise.resolve() };
    scope[BASIS_MODULE_KEY] = store;
  }
  return store;
}

type BasisFactory = (options: {
  locateFile: (path: string) => string;
}) => Promise<BasisModule>;

function loadBasisScript(jsUrl: string): Promise<void> {
  const scope = globalThis as {
    document?: {
      createElement(tag: string): {
        src: string;
        onload: (() => void) | null;
        onerror: (() => void) | null;
      };
      head?: { append(node: unknown): void };
    };
    importScripts?: (...urls: string[]) => void;
  };
  if (scope.document !== undefined && scope.document.head !== undefined) {
    return new Promise((resolve, reject) => {
      const script = scope.document!.createElement("script");
      script.src = jsUrl;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(
          new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "basis transcoder script failed to load",
          ),
        );
      scope.document!.head!.append(script);
    });
  }
  if (typeof scope.importScripts === "function") {
    try {
      scope.importScripts(jsUrl);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        new Forge3DError(
          "UNSUPPORTED_FEATURE",
          `basis transcoder script failed to load: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return Promise.reject(
    new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "basis transcoder requires a Window or Worker global scope",
    ),
  );
}

function loadBasisModule(
  jsUrl: string,
  wasmUrl: string,
): Promise<BasisModule> {
  const store = basisModuleStore();
  const key = JSON.stringify([jsUrl, wasmUrl]);
  const cached = store.modules.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const promise = store.tail.then(async () => {
    await loadBasisScript(jsUrl);
    const factory = (globalThis as { BASIS?: BasisFactory }).BASIS;
    if (typeof factory !== "function") {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "basis transcoder script did not expose the BASIS factory",
      );
    }
    return factory({ locateFile: () => wasmUrl });
  });
  store.tail = promise.then(
    () => undefined,
    () => undefined,
  );
  store.modules.set(key, promise);
  promise.catch(() => {
    if (store.modules.get(key) === promise) {
      store.modules.delete(key);
    }
  });
  return promise;
}

class BundledBasisTranscoder implements BasisTranscoderAdapter {
  constructor(
    private readonly jsUrl: string,
    private readonly wasmUrl: string,
    private readonly maxBytes: number,
    private readonly expectedLevels: number,
  ) {}

  async transcode(
    data: Uint8Array,
    target: TextureFormat,
    colorSpace: TextureColorSpace,
    signal?: AbortSignal,
  ): Promise<TextureImageSnapshot> {
    throwIfAborted(signal);
    const module = await loadBasisModule(this.jsUrl, this.wasmUrl);
    throwIfAborted(signal);
    const enumName = BASIS_TARGET_ENUM[target];
    const enumEntry = enumName
      ? module.transcoder_texture_format[enumName]
      : undefined;
    const formatValue =
      typeof enumEntry === "object" && enumEntry !== null && "value" in enumEntry
        ? (enumEntry as { value: unknown }).value
        : enumEntry;
    if (formatValue === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `basis transcoder does not expose a target format for ${target}`,
      );
    }
    const file = new module.KTX2File(data);
    try {
      if (file.isValid() !== true) {
        throw invalid("basis container is not a valid KTX2 file", "ktx2");
      }
      if (file.startTranscoding() !== true) {
        throw invalid("basis startTranscoding failed", "ktx2");
      }
      const width = file.getWidth();
      const height = file.getHeight();
      const levelCount = file.getLevels();
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > MAX_TEXTURE_DIMENSION ||
        height > MAX_TEXTURE_DIMENSION ||
        levelCount < 1
      ) {
        throw invalid(
          "basis image dimensions are out of range",
          "ktx2.levels",
        );
      }
      if (levelCount !== this.expectedLevels) {
        throw invalid(
          `basis level count ${levelCount} does not match the container`,
          "ktx2.levels",
        );
      }
      const layers = file.getLayers?.() ?? 1;
      const faces = file.getFaces?.() ?? 1;
      if (layers !== 0 && layers !== 1) {
        throw invalid("basis array textures are not supported", "ktx2.layers");
      }
      if (faces !== 0 && faces !== 1) {
        throw invalid("basis cubemaps are not supported", "ktx2.faces");
      }
      const levels: TextureLevelSnapshot[] = [];
      let totalBytes = 0;
      let levelWidth = width;
      let levelHeight = height;
      for (let level = 0; level < levelCount; level += 1) {
        throwIfAborted(signal);
        const size = file.getImageTranscodedSizeInBytes(
          level,
          0,
          0,
          formatValue,
        );
        const expected = textureLevelByteLength(target, levelWidth, levelHeight);
        if (!Number.isSafeInteger(size) || size !== expected) {
          throw invalid(
            `basis level ${level} reports ${size} bytes; expected ${expected}`,
            "ktx2.levels",
          );
        }
        totalBytes += size;
        if (totalBytes > this.maxBytes) {
          throw new Forge3DError(
            "RESOURCE_LIMIT_EXCEEDED",
            `basis transcoded output exceeds the ${this.maxBytes} byte limit`,
          );
        }
        const dst = new Uint8Array(size);
        const result = file.transcodeImage(
          dst,
          level,
          0,
          0,
          formatValue,
          0,
          -1,
          -1,
        );
        if (!result) {
          throw new Forge3DError(
            "INVALID_INPUT",
            `basis transcodeImage failed for level ${level}`,
            { field: "ktx2.levels" },
          );
        }
        levels.push({ width: levelWidth, height: levelHeight, data: dst });
        levelWidth = Math.max(1, Math.floor(levelWidth / 2));
        levelHeight = Math.max(1, Math.floor(levelHeight / 2));
      }
      return {
        width,
        height,
        format: target,
        colorSpace,
        levels,
        compressed: isCompressedTextureFormat(target),
        sourceFormat: "basis",
        effectiveQuality:
          target === "rgba8unorm" || target === "rgba8unorm-srgb"
            ? "rgba8-fallback"
            : "transcoded",
      };
    } finally {
      try {
        file.close();
      } finally {
        file.delete();
      }
    }
  }
}

export class Ktx2Loader {
  readonly #adapter: BasisTranscoderAdapter | undefined;
  readonly #jsUrl: string;
  readonly #wasmUrl: string;
  #report: Ktx2TranscodeReport | undefined;

  constructor(options?: Ktx2LoaderOptions) {
    this.#adapter = options?.basisTranscoder;
    const defaultJs = new URL(
      "../assets/basis/basis_transcoder.js",
      import.meta.url,
    );
    this.#jsUrl = String(options?.basisJsUrl ?? defaultJs);
    this.#wasmUrl = String(
      options?.basisWasmUrl ??
        new URL("../assets/basis/basis_transcoder.wasm", import.meta.url),
    );
  }

  getLastReport(): Ktx2TranscodeReport | undefined {
    return this.#report === undefined
      ? undefined
      : { ...this.#report };
  }

  async load(
    source: BrowserByteSource,
    options: Ktx2LoadOptions,
  ): Promise<TextureImageSnapshot> {
    if (typeof options !== "object" || options === null) {
      throw invalid("ktx2 options must be an object", "ktx2.options");
    }
    const signal = options.signal;
    throwIfAborted(signal);
    const maxBytes = options.maxBytes ?? DEFAULT_KTX2_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw invalid("ktx2.maxBytes must be a positive safe integer", "maxBytes");
    }
    const semantic = options.semantic;
    if (
      semantic !== "base-color" &&
      semantic !== "normal" &&
      semantic !== "metallic-roughness" &&
      semantic !== "occlusion" &&
      semantic !== "emissive"
    ) {
      throw invalid("ktx2.semantic must be a texture semantic", "semantic");
    }
    const capabilities = options.capabilities;
    if (
      typeof capabilities !== "object" ||
      capabilities === null ||
      typeof capabilities.bc !== "boolean" ||
      typeof capabilities.etc2 !== "boolean" ||
      typeof capabilities.astc !== "boolean"
    ) {
      throw invalid(
        "ktx2.capabilities must report bc/etc2/astc booleans",
        "capabilities",
      );
    }
    const bytes = await readByteSource(
      source,
      signal === undefined ? { maxBytes } : { signal, maxBytes },
    );
    throwIfAborted(signal);

    let container: KTX2Container;
    try {
      container = read(bytes);
    } catch (error) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `ktx2 container could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        { field: "ktx2" },
      );
    }
    if (
      !Number.isSafeInteger(container.pixelWidth) ||
      !Number.isSafeInteger(container.pixelHeight) ||
      container.pixelWidth < 1 ||
      container.pixelHeight < 1 ||
      container.pixelWidth > MAX_TEXTURE_DIMENSION ||
      container.pixelHeight > MAX_TEXTURE_DIMENSION
    ) {
      throw invalid(
        "ktx2 dimensions must be integers between 1 and 16384",
        "ktx2.dimensions",
      );
    }
    if (
      (container.pixelDepth !== 0 && container.pixelDepth !== 1) ||
      (container.layerCount !== 0 && container.layerCount !== 1) ||
      (container.faceCount !== 0 && container.faceCount !== 1)
    ) {
      throw invalid(
        "ktx2 must be a 2D single-layer single-face texture",
        "ktx2.dimensions",
      );
    }
    if (container.levels.length === 0) {
      throw invalid("ktx2 must contain at least one mip level", "ktx2.levels");
    }
    let payloadBytes = 0;
    for (const level of container.levels) {
      payloadBytes += level.levelData.byteLength;
      if (payloadBytes > maxBytes) {
        throw new Forge3DError(
          "RESOURCE_LIMIT_EXCEEDED",
          `ktx2 payload exceeds the ${maxBytes} byte limit`,
        );
      }
    }

    const isBasis =
      container.supercompressionScheme === KHR_SUPERCOMPRESSION_BASISLZ ||
      container.vkFormat === VK_FORMAT_UNDEFINED;
    if (isBasis) {
      const schemeName = container.dataFormatDescriptor
        .map((descriptor) => descriptor.colorModel)
        .includes(KHR_DF_MODEL_ETC1S)
        ? "basislz"
        : container.dataFormatDescriptor
              .map((descriptor) => descriptor.colorModel)
              .includes(KHR_DF_MODEL_UASTC)
          ? "uastc"
          : "basis";
      const transfers = new Set(
        container.dataFormatDescriptor.map(
          (descriptor) => descriptor.transferFunction,
        ),
      );
      let colorSpace: TextureColorSpace;
      if (transfers.size === 1 && transfers.has(KHR_DF_TRANSFER_SRGB)) {
        colorSpace = "srgb";
      } else if (transfers.size === 1 && transfers.has(KHR_DF_TRANSFER_LINEAR)) {
        colorSpace = "linear";
      } else {
        const reason =
          "basis container does not declare a single linear or sRGB transfer function";
        this.#report = {
          sourceFormat: schemeName,
          requestedFormat: "basis",
          effectiveFormat: "unsupported",
          effectiveQuality: "unsupported",
          reason,
        };
        throw new Forge3DError("UNSUPPORTED_FEATURE", `ktx2 ${reason}`);
      }
      if (DATA_SEMANTICS.has(semantic) && colorSpace !== "linear") {
        const reason = `basis ${colorSpace} transfer cannot serve the ${semantic} semantic`;
        this.#report = {
          sourceFormat: schemeName,
          requestedFormat: "basis",
          effectiveFormat: "unsupported",
          effectiveQuality: "unsupported",
          reason,
        };
        throw new Forge3DError("UNSUPPORTED_FEATURE", `ktx2 ${reason}`);
      }
      return this.#loadBasis(
        bytes,
        schemeName,
        semantic,
        colorSpace,
        capabilities,
        signal,
        container.pixelWidth,
        container.pixelHeight,
        container.levels.length,
        maxBytes,
      );
    }
    if (container.supercompressionScheme !== KHR_SUPERCOMPRESSION_NONE) {
      this.#report = {
        sourceFormat: "ktx2",
        requestedFormat: `supercompression-${container.supercompressionScheme}`,
        effectiveFormat: "unsupported",
        effectiveQuality: "unsupported",
        reason: `supercompression scheme ${container.supercompressionScheme} is not supported`,
      };
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `ktx2 supercompression scheme ${container.supercompressionScheme} is not supported`,
      );
    }
    return this.#loadDirect(container, semantic, capabilities, signal);
  }

  #loadDirect(
    container: {
      vkFormat: number;
      pixelWidth: number;
      pixelHeight: number;
      levels: { levelData: Uint8Array }[];
    },
    semantic: TextureSemantic,
    capabilities: TextureFormatCapabilities,
    signal: AbortSignal | undefined,
  ): TextureImageSnapshot {
    const format = VK_FORMAT_MAP.get(container.vkFormat);
    if (format === undefined) {
      this.#report = {
        sourceFormat: "ktx2",
        requestedFormat: `vkFormat-${container.vkFormat}`,
        effectiveFormat: "unsupported",
        effectiveQuality: "unsupported",
        reason: `vkFormat ${container.vkFormat} is not a supported texture format`,
      };
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `ktx2 vkFormat ${container.vkFormat} is not supported`,
      );
    }
    const colorSpace: TextureColorSpace = isSrgbTextureFormat(format)
      ? "srgb"
      : "linear";
    try {
      checkSemanticColorContract(semantic, format, colorSpace, "ktx2");
    } catch (error) {
      if (error instanceof Forge3DError) {
        this.#report = {
          sourceFormat: "ktx2",
          requestedFormat: format,
          effectiveFormat: "unsupported",
          effectiveQuality: "unsupported",
          reason: error.message,
        };
      }
      throw error;
    }
    const feature = FEATURE_OF_FORMAT[format];
    if (
      feature !== undefined &&
      !(feature === "bc"
        ? capabilities.bc
        : feature === "etc2"
          ? capabilities.etc2
          : capabilities.astc)
    ) {
      const featureName = `texture-compression-${feature}`;
      this.#report = {
        sourceFormat: "ktx2",
        requestedFormat: format,
        effectiveFormat: "unsupported",
        effectiveQuality: "unsupported",
        reason: `device lacks ${featureName}`,
      };
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `ktx2 format ${format} requires device feature ${featureName}`,
      );
    }
    const levels: TextureLevelSnapshot[] = [];
    let width = container.pixelWidth;
    let height = container.pixelHeight;
    for (const [index, level] of container.levels.entries()) {
      throwIfAborted(signal);
      const expected = textureLevelByteLength(format, width, height);
      if (level.levelData.byteLength !== expected) {
        throw invalid(
          `ktx2 level ${index} must contain exactly ${expected} bytes`,
          "ktx2.levels",
        );
      }
      levels.push({
        width,
        height,
        data: new Uint8Array(level.levelData),
      });
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
    this.#report = {
      sourceFormat: "ktx2",
      requestedFormat: format,
      effectiveFormat: format,
      effectiveQuality: "native",
      reason: `vkFormat ${container.vkFormat} maps directly to ${format}`,
    };
    return {
      width: container.pixelWidth,
      height: container.pixelHeight,
      format,
      colorSpace,
      levels,
      compressed: isCompressedTextureFormat(format),
      sourceFormat: "ktx2",
      effectiveQuality: "native",
    };
  }

  async #loadBasis(
    bytes: Uint8Array,
    schemeName: string,
    semantic: TextureSemantic,
    colorSpace: TextureColorSpace,
    capabilities: TextureFormatCapabilities,
    signal: AbortSignal | undefined,
    width: number,
    height: number,
    levelCount: number,
    maxBytes: number,
  ): Promise<TextureImageSnapshot> {
    const srgb = colorSpace === "srgb";
    let target: TextureFormat;
    let reason: string;
    if (capabilities.astc) {
      target = srgb ? "astc-4x4-unorm-srgb" : "astc-4x4-unorm";
      reason = `transcoded to ${target} (astc preferred)`;
    } else if (capabilities.bc) {
      target = srgb ? "bc7-rgba-unorm-srgb" : "bc7-rgba-unorm";
      reason = `transcoded to ${target} (bc preferred)`;
    } else if (capabilities.etc2) {
      target = srgb ? "etc2-rgba8unorm-srgb" : "etc2-rgba8unorm";
      reason = `transcoded to ${target} (etc2 preferred)`;
    } else {
      target = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
      reason = `transcoded to ${target} (no block-compression features available)`;
    }
    let expectedBytes = 0;
    let expectedWidth = width;
    let expectedHeight = height;
    for (let level = 0; level < levelCount; level += 1) {
      expectedBytes += textureLevelByteLength(
        target,
        expectedWidth,
        expectedHeight,
      );
      if (expectedBytes > maxBytes) {
        throw new Forge3DError(
          "RESOURCE_LIMIT_EXCEEDED",
          `basis transcoded output would exceed the ${maxBytes} byte limit`,
        );
      }
      expectedWidth = Math.max(1, Math.floor(expectedWidth / 2));
      expectedHeight = Math.max(1, Math.floor(expectedHeight / 2));
    }
    const adapter =
      this.#adapter ??
      new BundledBasisTranscoder(
        this.#jsUrl,
        this.#wasmUrl,
        maxBytes,
        levelCount,
      );
    throwIfAborted(signal);
    const image = await adapter.transcode(bytes, target, colorSpace, signal);
    throwIfAborted(signal);
    const normalized = normalizeImage(
      { ...image, sourceFormat: "basis" },
      semantic,
      "ktx2.basis",
    );
    let outputBytes = 0;
    for (const level of normalized.levels) {
      outputBytes += level.data.byteLength;
      if (outputBytes > maxBytes) {
        throw new Forge3DError(
          "RESOURCE_LIMIT_EXCEEDED",
          `basis transcoded output exceeds the ${maxBytes} byte limit`,
        );
      }
    }
    normalized.effectiveQuality =
      target === "rgba8unorm" || target === "rgba8unorm-srgb"
        ? "rgba8-fallback"
        : "transcoded";
    if (
      normalized.width !== width ||
      normalized.height !== height ||
      normalized.format !== target
    ) {
      throw invalid(
        "basis transcoder output does not match the requested target",
        "ktx2.basis",
      );
    }
    this.#report = {
      sourceFormat: schemeName,
      requestedFormat: "basis",
      effectiveFormat: target,
      effectiveQuality: normalized.effectiveQuality,
      reason,
    };
    return normalized;
  }
}
