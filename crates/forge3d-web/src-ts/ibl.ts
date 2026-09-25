import { readByteSource } from "./browser-io.js";
import { Forge3DError } from "./index.js";
import type {
  BrowserByteSource,
  ByteReadOptions,
  IblCacheBackend,
  IblCacheOptions,
  IblOptions,
  IblPrefilterMode,
  IblPrecomputeTarget,
  IblPrecomputedSnapshot,
  IblQuality,
  IblReport,
  IblSnapshot,
  RgbeImage,
} from "./index.js";

export const IBL_MAX_SOURCE_DIMENSION = 16384;
const MAX_SOURCE_PIXELS = IBL_MAX_SOURCE_DIMENSION * IBL_MAX_SOURCE_DIMENSION;
const IBL_UNIFORM_BYTES = 32;
const CACHE_SCHEMA_VERSION = 2;
const CACHE_MAGIC = "F3DIBL01";
const CACHE_HEADER_BYTES = 76;
const DEFAULT_CACHE_NAMESPACE = "forge3d-ibl-v1";
const FALLBACK_CACHE_ORIGIN = "https://forge3d.invalid";

interface IblQualitySpec {
  quality: IblQuality;
  environmentSize: number;
  irradianceSize: number;
  specularSize: number;
  specularMipCount: number;
  brdfLutSize: number;
}

// Native IBLQuality tiers (1f4084a:src/core/ibl.rs): the environment cube
// matches the specular size and the BRDF LUT is 512 at every tier.
function nativeTier(
  quality: IblQuality,
  irradianceSize: number,
  specularSize: number,
  specularMipCount: number,
): IblQualitySpec {
  return {
    quality,
    environmentSize: specularSize,
    irradianceSize,
    specularSize,
    specularMipCount,
    brdfLutSize: 512,
  };
}

const IBL_QUALITY_SPECS: readonly IblQualitySpec[] = [
  nativeTier("low", 64, 128, 5),
  nativeTier("medium", 128, 256, 6),
  nativeTier("high", 256, 512, 7),
  nativeTier("ultra", 256, 1024, 8),
];

const IBL_QUALITY_INDEX: Record<IblQuality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 3,
};

function specFor(quality: IblQuality): IblQualitySpec {
  return IBL_QUALITY_SPECS[IBL_QUALITY_INDEX[quality]]!;
}

function mipSize(size: number, mip: number): number {
  return Math.max(1, size >> mip);
}

export function iblPreparedLengths(quality: IblQuality): {
  irradiance: number;
  specular: number;
  brdfLut: number;
} {
  const spec = specFor(quality);
  let specular = 0;
  for (let mip = 0; mip < spec.specularMipCount; mip += 1) {
    const size = mipSize(spec.specularSize, mip);
    specular += size * size * 6 * 8;
  }
  return {
    irradiance: spec.irradianceSize * spec.irradianceSize * 6 * 8,
    specular,
    brdfLut: spec.brdfLutSize * spec.brdfLutSize * 8,
  };
}

function iblQualityForPrepared(
  irradianceSize: number,
  specularSize: number,
  specularMipCount: number,
  brdfLutSize: number,
  irradianceLength: number,
  specularLength: number,
  brdfLutLength: number,
): IblQuality | undefined {
  for (const spec of IBL_QUALITY_SPECS) {
    if (
      spec.irradianceSize !== irradianceSize ||
      spec.specularSize !== specularSize ||
      spec.specularMipCount !== specularMipCount ||
      spec.brdfLutSize !== brdfLutSize
    ) {
      continue;
    }
    const lengths = iblPreparedLengths(spec.quality);
    if (
      lengths.irradiance === irradianceLength &&
      lengths.specular === specularLength &&
      lengths.brdfLut === brdfLutLength
    ) {
      return spec.quality;
    }
  }
  return undefined;
}

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function resourceLimit(message: string): Forge3DError {
  return new Forge3DError("RESOURCE_LIMIT_EXCEEDED", message);
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data: Uint8Array): Uint8Array {
  const hash = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLengthHigh = Math.floor(data.length / 0x20000000);
  const bitLengthLow = (data.length << 3) >>> 0;
  const paddedLength =
    ((data.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const tail = new DataView(padded.buffer);
  tail.setUint32(paddedLength - 8, bitLengthHigh >>> 0);
  tail.setUint32(paddedLength - 4, bitLengthLow);
  const w = new Uint32Array(64);
  const view = new DataView(padded.buffer);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(block + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15]!;
      const b = w[index - 2]!;
      const s0 =
        (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) >>> 0;
      const s1 =
        (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) >>>
        0;
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 =
        (((e! >>> 6) | (e! << 26)) ^
          ((e! >>> 11) | (e! << 21)) ^
          ((e! >>> 25) | (e! << 7))) >>>
        0;
      const ch = ((e! & f!) ^ (~e! & g!)) >>> 0;
      const temp1 =
        (h! + s1 + ch + SHA256_K[index]! + w[index]!) >>> 0;
      const s0 =
        (((a! >>> 2) | (a! << 30)) ^
          ((a! >>> 13) | (a! << 19)) ^
          ((a! >>> 22) | (a! << 10))) >>>
        0;
      const maj = ((a! & b!) ^ (a! & c!) ^ (b! & c!)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 8; index += 1) {
    digestView.setUint32(index * 4, hash[index]!);
  }
  return digest;
}

function sha256Hex(data: Uint8Array): string {
  const digest = sha256(data);
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

interface RgbeCursor {
  position: number;
}

function rgbeLine(data: Uint8Array, cursor: RgbeCursor): string | undefined {
  if (cursor.position >= data.length) {
    return undefined;
  }
  let end = cursor.position;
  while (end < data.length && data[end] !== 0x0a) {
    end += 1;
  }
  let lineEnd = end;
  if (lineEnd > cursor.position && data[lineEnd - 1] === 0x0d) {
    lineEnd -= 1;
  }
  let text = "";
  for (let index = cursor.position; index < lineEnd; index += 1) {
    text += String.fromCharCode(data[index]!);
  }
  cursor.position = end < data.length ? end + 1 : end;
  return text;
}

function rgbePixelToFloat(pixel: Uint8Array, out: Float32Array, offset: number) {
  const exponent = pixel[3]!;
  if (exponent === 0) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 1;
    return;
  }
  const scale = Math.pow(2, exponent - 136);
  out[offset] = pixel[0]! * scale;
  out[offset + 1] = pixel[1]! * scale;
  out[offset + 2] = pixel[2]! * scale;
  out[offset + 3] = 1;
}

export function decodeRgbe(data: Uint8Array): RgbeImage {
  if (!(data instanceof Uint8Array)) {
    throw invalid("RGBE input must be a Uint8Array");
  }
  const cursor: RgbeCursor = { position: 0 };
  const magic = rgbeLine(data, cursor);
  if (magic === undefined || (magic !== "#?RADIANCE" && magic !== "#?RGBE")) {
    throw invalid("RGBE header magic is missing or unrecognized");
  }
  let sawFormat = false;
  let resolutionLine: string | undefined;
  for (;;) {
    const line = rgbeLine(data, cursor);
    if (line === undefined) {
      throw invalid("RGBE header is unterminated");
    }
    if (line === "") {
      resolutionLine = rgbeLine(data, cursor);
      break;
    }
    if (line === "FORMAT=32-bit_rle_rgbe") {
      sawFormat = true;
      continue;
    }
    if (line.startsWith("FORMAT=")) {
      throw invalid(`RGBE format '${line.slice(7)}' is not supported`);
    }
  }
  if (!sawFormat) {
    throw invalid("RGBE header is missing FORMAT=32-bit_rle_rgbe");
  }
  if (resolutionLine === undefined) {
    throw invalid("RGBE resolution line is missing");
  }
  const match = /^([+-])Y (\d+) ([+-])X (\d+)$/.exec(resolutionLine);
  if (match === null) {
    throw invalid(`RGBE resolution '${resolutionLine}' is not supported`);
  }
  const ySign = match[1] === "-" ? -1 : 1;
  const height = Number(match[2]);
  const xSign = match[3] === "-" ? -1 : 1;
  const width = Number(match[4]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > IBL_MAX_SOURCE_DIMENSION ||
    height > IBL_MAX_SOURCE_DIMENSION
  ) {
    throw resourceLimit(
      `RGBE dimensions ${width}x${height} exceed ${IBL_MAX_SOURCE_DIMENSION}`,
    );
  }
  if (width * height > MAX_SOURCE_PIXELS) {
    throw resourceLimit("RGBE pixel count exceeds the supported limit");
  }
  const rgba = new Float32Array(width * height * 4);
  const pixel = new Uint8Array(4);
  const scanline = new Uint8Array(width * 4);
  const modernScanlines =
    width >= 8 &&
    width <= 32767 &&
    cursor.position + 4 <= data.length &&
    data[cursor.position] === 2 &&
    data[cursor.position + 1] === 2;
  for (let row = 0; row < height; row += 1) {
    if (modernScanlines) {
      if (cursor.position + 4 > data.length) {
        throw invalid("RGBE data is truncated");
      }
      const marker = data[cursor.position]!;
      const marker2 = data[cursor.position + 1]!;
      const encodedWidth =
        (data[cursor.position + 2]! << 8) | data[cursor.position + 3]!;
      if (marker !== 2 || marker2 !== 2) {
        throw invalid("RGBE scanline marker is malformed");
      }
      if (encodedWidth !== width) {
        throw invalid("RGBE scanline width does not match the header");
      }
      cursor.position += 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let x = 0;
        while (x < width) {
          if (cursor.position >= data.length) {
            throw invalid("RGBE RLE data is truncated");
          }
          const count = data[cursor.position]!;
          cursor.position += 1;
          if (count === 0) {
            throw invalid("RGBE RLE run count cannot be zero");
          }
          if (count > 128) {
            const runLength = count - 128;
            if (x + runLength > width) {
              throw invalid("RGBE RLE run overflows the scanline");
            }
            if (cursor.position >= data.length) {
              throw invalid("RGBE RLE data is truncated");
            }
            const value = data[cursor.position]!;
            cursor.position += 1;
            scanline.fill(value, channel * width + x, channel * width + x + runLength);
            x += runLength;
          } else {
            if (x + count > width) {
              throw invalid("RGBE literal run overflows the scanline");
            }
            if (cursor.position + count > data.length) {
              throw invalid("RGBE literal data is truncated");
            }
            scanline.set(
              data.subarray(cursor.position, cursor.position + count),
              channel * width + x,
            );
            cursor.position += count;
            x += count;
          }
        }
      }
    } else {
      if (cursor.position + width * 4 > data.length) {
        throw invalid("RGBE flat pixel data is truncated");
      }
      const flat = data.subarray(cursor.position, cursor.position + width * 4);
      for (let x = 0; x < width; x += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          scanline[channel * width + x] = flat[x * 4 + channel]!;
        }
      }
      cursor.position += width * 4;
    }
    const targetRow = ySign < 0 ? row : height - 1 - row;
    for (let x = 0; x < width; x += 1) {
      const sourceX = xSign < 0 ? width - 1 - x : x;
      pixel[0] = scanline[sourceX]!;
      pixel[1] = scanline[width + sourceX]!;
      pixel[2] = scanline[width * 2 + sourceX]!;
      pixel[3] = scanline[width * 3 + sourceX]!;
      rgbePixelToFloat(pixel, rgba, (targetRow * width + x) * 4);
    }
  }
  for (let index = cursor.position; index < data.length; index += 1) {
    const byte = data[index]!;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      throw invalid("RGBE has non-whitespace trailing data");
    }
  }
  if (!rgba.every((value) => Number.isFinite(value))) {
    throw invalid("RGBE decoded values must be finite");
  }
  return { width, height, data: rgba };
}

interface CacheByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
}

interface CacheStorageLike {
  open(name: string): Promise<{
    match(request: unknown): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | undefined>;
    put(request: unknown, response: unknown): Promise<void>;
  }>;
}

interface OpfsFileHandleLike {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface OpfsDirectoryHandleLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
}

function cacheStorageApi(): CacheStorageLike | undefined {
  const candidate = (
    globalThis as typeof globalThis & { caches?: CacheStorageLike }
  ).caches;
  if (candidate !== undefined && typeof candidate.open === "function") {
    return candidate;
  }
  return undefined;
}

function opfsRoot(): (() => Promise<OpfsDirectoryHandleLike>) | undefined {
  const navigatorLike = (
    globalThis as typeof globalThis & {
      navigator?: { storage?: { getDirectory?: () => Promise<OpfsDirectoryHandleLike> } };
    }
  ).navigator;
  const getDirectory = navigatorLike?.storage?.getDirectory;
  if (typeof getDirectory === "function") {
    return () => getDirectory.call(navigatorLike.storage);
  }
  return undefined;
}

function cacheRequestUrl(key: string): string {
  const location = (
    globalThis as typeof globalThis & { location?: { origin?: string } }
  ).location;
  const origin =
    typeof location?.origin === "string" && location.origin.length > 0
      ? location.origin
      : FALLBACK_CACHE_ORIGIN;
  return `${origin}/.forge3d/ibl/${key}`;
}

function cacheStorageStore(namespace: string): CacheByteStore {
  return {
    async get(key) {
      const caches = cacheStorageApi();
      if (caches === undefined) {
        return undefined;
      }
      const cache = await caches.open(namespace);
      const response = await cache.match(cacheRequestUrl(key));
      if (response === undefined || response === null) {
        return undefined;
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async put(key, value) {
      const caches = cacheStorageApi();
      if (caches === undefined) {
        return;
      }
      const cache = await caches.open(namespace);
      const ResponseCtor = (
        globalThis as typeof globalThis & {
          Response?: new (body: Uint8Array, init?: object) => unknown;
        }
      ).Response;
      if (ResponseCtor === undefined) {
        return;
      }
      await cache.put(
        cacheRequestUrl(key),
        new ResponseCtor(value.slice(), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    },
  };
}

function opfsStore(namespace: string): CacheByteStore {
  const directory = async () => {
    const root = opfsRoot();
    if (root === undefined) {
      return undefined;
    }
    return (await root()).getDirectoryHandle(namespace, { create: true });
  };
  return {
    async get(key) {
      const dir = await directory();
      if (dir === undefined) {
        return undefined;
      }
      let handle: OpfsFileHandleLike;
      try {
        handle = await dir.getFileHandle(`${key}.ibl`, { create: false });
      } catch {
        return undefined;
      }
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async put(key, value) {
      const dir = await directory();
      if (dir === undefined) {
        return;
      }
      const handle = await dir.getFileHandle(`${key}.ibl`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(value);
      await writable.close();
    },
  };
}

function resolveCacheBackend(requested: IblCacheBackend): IblCacheBackend {
  switch (requested) {
    case "auto":
      if (cacheStorageApi() !== undefined) {
        return "cache-storage";
      }
      if (opfsRoot() !== undefined) {
        return "opfs";
      }
      return "none";
    case "cache-storage":
      return cacheStorageApi() !== undefined ? "cache-storage" : "none";
    case "opfs":
      return opfsRoot() !== undefined ? "opfs" : "none";
    case "none":
      return "none";
    default:
      throw invalid("IBL cache backend must be auto, cache-storage, opfs, or none");
  }
}

function encodeCacheEntry(
  quality: IblQuality,
  prepared: IblPrecomputedSnapshot,
): Uint8Array {
  const payloadLength =
    prepared.irradiance.length +
    prepared.specular.length +
    prepared.brdfLut.length;
  const bytes = new Uint8Array(CACHE_HEADER_BYTES + payloadLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < CACHE_MAGIC.length; index += 1) {
    bytes[index] = CACHE_MAGIC.charCodeAt(index);
  }
  view.setUint32(8, CACHE_SCHEMA_VERSION, true);
  view.setUint32(12, IBL_QUALITY_INDEX[quality], true);
  view.setUint32(16, prepared.irradianceSize, true);
  view.setUint32(20, prepared.specularSize, true);
  view.setUint32(24, prepared.specularMipCount, true);
  view.setUint32(28, prepared.brdfLutSize, true);
  view.setUint32(32, prepared.irradiance.length, true);
  view.setUint32(36, prepared.specular.length, true);
  view.setUint32(40, prepared.brdfLut.length, true);
  const payload = new Uint8Array(payloadLength);
  payload.set(prepared.irradiance, 0);
  payload.set(prepared.specular, prepared.irradiance.length);
  payload.set(
    prepared.brdfLut,
    prepared.irradiance.length + prepared.specular.length,
  );
  bytes.set(sha256(payload), 44);
  bytes.set(payload, CACHE_HEADER_BYTES);
  return bytes;
}

interface DecodedCacheEntry {
  quality: IblQuality;
  prepared: IblPrecomputedSnapshot;
}

function decodeCacheEntry(bytes: Uint8Array): DecodedCacheEntry | undefined {
  if (bytes.length < CACHE_HEADER_BYTES) {
    return undefined;
  }
  for (let index = 0; index < CACHE_MAGIC.length; index += 1) {
    if (bytes[index] !== CACHE_MAGIC.charCodeAt(index)) {
      return undefined;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== CACHE_SCHEMA_VERSION) {
    return undefined;
  }
  const qualityIndex = view.getUint32(12, true);
  const spec = IBL_QUALITY_SPECS[qualityIndex];
  if (spec === undefined) {
    return undefined;
  }
  const irradianceSize = view.getUint32(16, true);
  const specularSize = view.getUint32(20, true);
  const specularMipCount = view.getUint32(24, true);
  const brdfLutSize = view.getUint32(28, true);
  const irradianceLength = view.getUint32(32, true);
  const specularLength = view.getUint32(36, true);
  const brdfLength = view.getUint32(40, true);
  const quality = iblQualityForPrepared(
    irradianceSize,
    specularSize,
    specularMipCount,
    brdfLutSize,
    irradianceLength,
    specularLength,
    brdfLength,
  );
  if (quality !== spec.quality) {
    return undefined;
  }
  const payloadLength = irradianceLength + specularLength + brdfLength;
  if (bytes.length !== CACHE_HEADER_BYTES + payloadLength) {
    return undefined;
  }
  const payload = bytes.subarray(CACHE_HEADER_BYTES);
  const expectedDigest = sha256(payload);
  for (let index = 0; index < 32; index += 1) {
    if (bytes[44 + index] !== expectedDigest[index]) {
      return undefined;
    }
  }
  return {
    quality,
    prepared: {
      format: "rgba16float",
      irradianceSize,
      specularSize,
      specularMipCount,
      brdfLutSize,
      irradiance: payload.slice(0, irradianceLength),
      specular: payload.slice(irradianceLength, irradianceLength + specularLength),
      brdfLut: payload.slice(irradianceLength + specularLength),
    },
  };
}

export class IblCache {
  readonly #namespace: string;
  readonly #backend: IblCacheBackend;
  readonly #store: CacheByteStore | undefined;

  constructor(options: IblCacheOptions = {}) {
    if (typeof options !== "object" || options === null) {
      throw invalid("IBL cache options must be an object");
    }
    const namespace = options.namespace ?? DEFAULT_CACHE_NAMESPACE;
    if (
      typeof namespace !== "string" ||
      namespace.length === 0 ||
      /[\\/?#]/.test(namespace)
    ) {
      throw invalid(
        "IBL cache namespace must be a non-empty name without path separators",
      );
    }
    this.#namespace = namespace;
    this.#backend = resolveCacheBackend(options.backend ?? "auto");
    this.#store =
      this.#backend === "cache-storage"
        ? cacheStorageStore(this.#namespace)
        : this.#backend === "opfs"
          ? opfsStore(this.#namespace)
          : undefined;
  }

  get backend(): IblCacheBackend {
    return this.#backend;
  }

  async get(key: string): Promise<IblPrecomputedSnapshot | undefined> {
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw invalid("IBL cache key must be a 64-character lowercase hex digest");
    }
    if (this.#store === undefined) {
      return undefined;
    }
    try {
      const bytes = await this.#store.get(key);
      if (bytes === undefined || bytes === null) {
        return undefined;
      }
      return decodeCacheEntry(bytes)?.prepared;
    } catch {
      return undefined;
    }
  }

  async put(key: string, value: IblPrecomputedSnapshot): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw invalid("IBL cache key must be a 64-character lowercase hex digest");
    }
    if (this.#store === undefined) {
      return;
    }
    const prepared = normalizePrepared(value, "cache value");
    const quality = iblQualityForPrepared(
      prepared.irradianceSize,
      prepared.specularSize,
      prepared.specularMipCount,
      prepared.brdfLutSize,
      prepared.irradiance.length,
      prepared.specular.length,
      prepared.brdfLut.length,
    );
    if (quality === undefined) {
      throw invalid("IBL cache value does not match a known quality profile");
    }
    try {
      await this.#store.put(key, encodeCacheEntry(quality, prepared));
    } catch {}
  }
}

function normalizeRotation(rotation: number | undefined): number {
  if (rotation === undefined) {
    return 0;
  }
  if (!Number.isFinite(rotation)) {
    throw invalid("IBL rotationDegrees must be finite");
  }
  const normalized = rotation % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeIntensity(intensity: number | undefined): number {
  if (intensity === undefined) {
    return 1;
  }
  if (!Number.isFinite(intensity) || intensity < 0) {
    throw invalid("IBL intensity must be finite and non-negative");
  }
  return intensity;
}

function normalizeQuality(quality: IblQuality | undefined): IblQuality {
  if (quality === undefined) {
    return "medium";
  }
  if (IBL_QUALITY_INDEX[quality] === undefined) {
    throw invalid(`IBL quality '${quality}' is not supported`);
  }
  return quality;
}

function normalizeSource(image: RgbeImage): {
  width: number;
  height: number;
  data: Float32Array;
  sourceHash: string;
} {
  if (typeof image !== "object" || image === null) {
    throw invalid("IBL source image must be an object");
  }
  const { width, height, data } = image;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalid("IBL source dimensions must be positive integers");
  }
  if (width > IBL_MAX_SOURCE_DIMENSION || height > IBL_MAX_SOURCE_DIMENSION) {
    throw resourceLimit(
      `IBL source dimensions ${width}x${height} exceed ${IBL_MAX_SOURCE_DIMENSION}`,
    );
  }
  const pixels = width * height;
  if (pixels > MAX_SOURCE_PIXELS) {
    throw resourceLimit("IBL source pixel count exceeds the supported limit");
  }
  if (!(data instanceof Float32Array) || data.length !== pixels * 4) {
    throw invalid("IBL source data must be a Float32Array of width*height*4");
  }
  for (let index = 0; index < data.length; index += 1) {
    if (!Number.isFinite(data[index]!)) {
      throw invalid("IBL source data must contain finite floats");
    }
  }
  const copy = new Float32Array(data);
  const header = new Uint8Array(8 + copy.byteLength);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width, true);
  headerView.setUint32(4, height, true);
  header.set(
    new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength),
    8,
  );
  return { width, height, data: copy, sourceHash: sha256Hex(header) };
}

function normalizePrepared(
  value: unknown,
  field: string,
): IblPrecomputedSnapshot {
  if (typeof value !== "object" || value === null) {
    throw invalid(`${field} must be an object`);
  }
  const prepared = value as IblPrecomputedSnapshot;
  if (prepared.format !== "rgba16float") {
    throw invalid(`${field}.format must be 'rgba16float'`);
  }
  for (const [name, size] of [
    ["irradianceSize", prepared.irradianceSize],
    ["specularSize", prepared.specularSize],
    ["specularMipCount", prepared.specularMipCount],
    ["brdfLutSize", prepared.brdfLutSize],
  ] as const) {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw invalid(`${field}.${name} must be a positive integer`);
    }
  }
  for (const [name, bytes] of [
    ["irradiance", prepared.irradiance],
    ["specular", prepared.specular],
    ["brdfLut", prepared.brdfLut],
  ] as const) {
    if (!(bytes instanceof Uint8Array)) {
      throw invalid(`${field}.${name} must be a Uint8Array`);
    }
  }
  return {
    format: "rgba16float",
    irradianceSize: prepared.irradianceSize,
    specularSize: prepared.specularSize,
    specularMipCount: prepared.specularMipCount,
    brdfLutSize: prepared.brdfLutSize,
    irradiance: new Uint8Array(prepared.irradiance),
    specular: new Uint8Array(prepared.specular),
    brdfLut: new Uint8Array(prepared.brdfLut),
  };
}

function clonePrepared(
  prepared: IblPrecomputedSnapshot | undefined,
): IblPrecomputedSnapshot | undefined {
  if (prepared === undefined) {
    return undefined;
  }
  return {
    format: "rgba16float",
    irradianceSize: prepared.irradianceSize,
    specularSize: prepared.specularSize,
    specularMipCount: prepared.specularMipCount,
    brdfLutSize: prepared.brdfLutSize,
    irradiance: new Uint8Array(prepared.irradiance),
    specular: new Uint8Array(prepared.specular),
    brdfLut: new Uint8Array(prepared.brdfLut),
  };
}

function checkedSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw resourceLimit("IBL byte estimate exceeds safe integer limits");
    }
  }
  return total;
}

interface NormalizedIblSnapshot {
  width: number;
  height: number;
  data: Float32Array;
  sourceHash: string;
  intensity: number;
  rotationDegrees: number;
  requestedQuality: IblQuality;
  effectiveQuality: IblQuality;
  prefilter: IblPrefilterMode;
  prepared: IblPrecomputedSnapshot | undefined;
  report: IblReport;
}

function normalizeIblSnapshot(value: unknown): NormalizedIblSnapshot {
  if (typeof value !== "object" || value === null) {
    throw invalid("IBL snapshot must be an object");
  }
  const snapshot = value as IblSnapshot;
  const source = snapshot.source;
  if (typeof source !== "object" || source === null) {
    throw invalid("IBL snapshot source must be an object");
  }
  const normalized = normalizeSource({
    width: source.width,
    height: source.height,
    data: source.data,
  });
  if (
    typeof source.sourceHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(source.sourceHash)
  ) {
    throw invalid("IBL snapshot sourceHash must be a 64-character hex digest");
  }
  if (source.sourceHash !== normalized.sourceHash) {
    throw invalid("IBL snapshot sourceHash does not match the source data");
  }
  const intensity = normalizeIntensity(snapshot.intensity);
  const rotationDegrees = snapshot.rotationDegrees;
  if (
    !Number.isFinite(rotationDegrees) ||
    rotationDegrees < 0 ||
    rotationDegrees >= 360
  ) {
    throw invalid(
      "IBL snapshot rotationDegrees must be canonical within [0, 360)",
    );
  }
  const requestedQuality = normalizeQuality(snapshot.requestedQuality);
  const effectiveQuality = normalizeQuality(snapshot.effectiveQuality);
  const prefilter = normalizePrefilter(snapshot.prefilter);
  if (IBL_QUALITY_INDEX[effectiveQuality] > IBL_QUALITY_INDEX[requestedQuality]) {
    throw invalid("IBL effectiveQuality cannot exceed requestedQuality");
  }
  const prepared =
    snapshot.prepared === undefined || snapshot.prepared === null
      ? undefined
      : normalizePrepared(snapshot.prepared, "IBL snapshot prepared");
  if (prepared !== undefined) {
    const preparedQuality = iblQualityForPrepared(
      prepared.irradianceSize,
      prepared.specularSize,
      prepared.specularMipCount,
      prepared.brdfLutSize,
      prepared.irradiance.length,
      prepared.specular.length,
      prepared.brdfLut.length,
    );
    if (preparedQuality !== effectiveQuality) {
      throw invalid(
        "IBL prepared payload does not match the effective quality table",
      );
    }
  }
  const report = snapshot.report;
  if (typeof report !== "object" || report === null) {
    throw invalid("IBL snapshot report must be an object");
  }
  if (
    normalizeQuality(report.requestedQuality) !== requestedQuality ||
    normalizeQuality(report.effectiveQuality) !== effectiveQuality
  ) {
    throw invalid("IBL report quality does not match the snapshot");
  }
  if (
    report.cacheBackend !== "cache-storage" &&
    report.cacheBackend !== "opfs" &&
    report.cacheBackend !== "none"
  ) {
    throw invalid("IBL report cacheBackend is not an actual backend");
  }
  if (typeof report.cacheHit !== "boolean") {
    throw invalid("IBL report cacheHit must be a boolean");
  }
  const expectedMode =
    prepared === undefined ? "runtime-precompute" : "prepared-upload";
  if (report.effectiveMode !== expectedMode) {
    throw invalid(
      `IBL report effectiveMode must be '${expectedMode}' for this snapshot`,
    );
  }
  if (report.brdfApproximation !== "split-sum-ggx") {
    throw invalid("IBL report brdfApproximation must be 'split-sum-ggx'");
  }
  if (typeof report.reason !== "string") {
    throw invalid("IBL report reason must be a string");
  }
  return {
    ...normalized,
    sourceHash: normalized.sourceHash,
    intensity,
    rotationDegrees,
    requestedQuality,
    effectiveQuality,
    prefilter,
    prepared,
    report: { ...report },
  };
}

function normalizePrefilter(value: unknown): IblPrefilterMode {
  if (value === undefined || value === null) {
    return "per-mip";
  }
  if (value !== "native" && value !== "per-mip") {
    throw invalid("IBL prefilter must be 'native' or 'per-mip'");
  }
  return value;
}

export class ImageBasedLighting {
  readonly #width: number;
  readonly #height: number;
  readonly #data: Float32Array;
  readonly #sourceHash: string;
  readonly #intensity: number;
  readonly #rotationDegrees: number;
  readonly #requestedQuality: IblQuality;
  readonly #prefilter: IblPrefilterMode;
  readonly #prepared: IblPrecomputedSnapshot | undefined;
  readonly #report: IblReport;

  private constructor(
    source: { width: number; height: number; data: Float32Array; sourceHash: string },
    intensity: number,
    rotationDegrees: number,
    requestedQuality: IblQuality,
    prefilter: IblPrefilterMode,
    prepared: IblPrecomputedSnapshot | undefined,
    report: IblReport,
  ) {
    this.#width = source.width;
    this.#height = source.height;
    this.#data = source.data;
    this.#sourceHash = source.sourceHash;
    this.#intensity = intensity;
    this.#rotationDegrees = rotationDegrees;
    this.#requestedQuality = requestedQuality;
    this.#prefilter = prefilter;
    this.#prepared = prepared;
    this.#report = report;
  }

  static async fromRGBE(
    source: BrowserByteSource,
    options: IblOptions & ByteReadOptions = {},
  ): Promise<ImageBasedLighting> {
    const bytes = await readByteSource(source, options);
    const image = decodeRgbe(bytes);
    return ImageBasedLighting.fromLinear(image, options);
  }

  static async fromLinear(
    image: RgbeImage,
    options: IblOptions = {},
  ): Promise<ImageBasedLighting> {
    if (typeof options !== "object" || options === null) {
      throw invalid("IBL options must be an object");
    }
    const source = normalizeSource(image);
    const intensity = normalizeIntensity(options.intensity);
    const rotationDegrees = normalizeRotation(options.rotationDegrees);
    const requestedQuality = normalizeQuality(options.quality);
    return new ImageBasedLighting(
      source,
      intensity,
      rotationDegrees,
      requestedQuality,
      normalizePrefilter(options.prefilter),
      undefined,
      {
        requestedQuality,
        effectiveQuality: requestedQuality,
        cacheBackend: "none",
        cacheHit: false,
        effectiveMode: "runtime-precompute",
        brdfApproximation: "split-sum-ggx",
        reason: "not prepared",
      },
    );
  }

  get prepared(): boolean {
    return this.#prepared !== undefined;
  }

  get report(): IblReport {
    return { ...this.#report };
  }

  /** Specular prefilter schedule used for this environment. */
  get prefilter(): IblPrefilterMode {
    return this.#prefilter;
  }

  async cacheKey(): Promise<string> {
    const encoder = new TextEncoder();
    const head = encoder.encode(this.#sourceHash);
    const bytes = new Uint8Array(head.length + 20);
    bytes.set(head, 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(head.length, IBL_QUALITY_INDEX[this.#requestedQuality], true);
    view.setFloat32(head.length + 4, this.#intensity, true);
    view.setFloat32(head.length + 8, this.#rotationDegrees, true);
    view.setUint32(head.length + 12, CACHE_SCHEMA_VERSION, true);
    view.setUint32(head.length + 16, this.#prefilter === "native" ? 0 : 1, true);
    return sha256Hex(bytes);
  }

  async prepare(
    target: IblPrecomputeTarget,
    cache?: IblCache,
  ): Promise<ImageBasedLighting> {
    if (
      typeof target !== "object" ||
      target === null ||
      typeof target.precomputeIbl !== "function"
    ) {
      throw invalid("IBL prepare target must implement precomputeIbl");
    }
    if (cache !== undefined && !(cache instanceof IblCache)) {
      throw invalid("IBL cache must be an IblCache instance");
    }
    const key = await this.cacheKey();
    if (cache !== undefined) {
      const hit = await cache.get(key);
      if (hit !== undefined) {
        const effectiveQuality = iblQualityForPrepared(
          hit.irradianceSize,
          hit.specularSize,
          hit.specularMipCount,
          hit.brdfLutSize,
          hit.irradiance.length,
          hit.specular.length,
          hit.brdfLut.length,
        );
        if (
          effectiveQuality !== undefined &&
          IBL_QUALITY_INDEX[effectiveQuality] <=
            IBL_QUALITY_INDEX[this.#requestedQuality]
        ) {
          return new ImageBasedLighting(
            this.#sourceCopy(),
            this.#intensity,
            this.#rotationDegrees,
            this.#requestedQuality,
            this.#prefilter,
            clonePrepared(hit),
            {
              requestedQuality: this.#requestedQuality,
              effectiveQuality,
              cacheBackend: cache.backend,
              cacheHit: true,
              effectiveMode: "prepared-upload",
              brdfApproximation: "split-sum-ggx",
              reason: "cache hit",
            },
          );
        }
      }
    }
    const result = await target.precomputeIbl(this.snapshot());
    const normalized = normalizeIblSnapshot(result);
    if (
      normalized.width !== this.#width ||
      normalized.height !== this.#height ||
      normalized.sourceHash !== this.#sourceHash
    ) {
      throw invalid("precomputeIbl returned a mismatched IBL source");
    }
    if (
      normalized.requestedQuality !== this.#requestedQuality ||
      normalized.prefilter !== this.#prefilter ||
      Math.abs(normalized.intensity - this.#intensity) > 1e-4 ||
      Math.abs(normalized.rotationDegrees - this.#rotationDegrees) > 1e-4
    ) {
      throw invalid("precomputeIbl returned mismatched IBL settings");
    }
    if (normalized.prepared === undefined) {
      throw invalid("precomputeIbl must return a prepared IBL snapshot");
    }
    if (cache !== undefined) {
      try {
        await cache.put(key, clonePrepared(normalized.prepared)!);
      } catch {}
    }
    return new ImageBasedLighting(
      this.#sourceCopy(),
      this.#intensity,
      this.#rotationDegrees,
      this.#requestedQuality,
      this.#prefilter,
      normalized.prepared,
      {
        requestedQuality: this.#requestedQuality,
        effectiveQuality: normalized.effectiveQuality,
        cacheBackend: cache?.backend ?? "none",
        cacheHit: false,
        effectiveMode: "prepared-upload",
        brdfApproximation: "split-sum-ggx",
        reason: normalized.report.reason,
      },
    );
  }

  snapshot(): IblSnapshot {
    const snapshot: IblSnapshot = {
      source: {
        width: this.#width,
        height: this.#height,
        data: new Float32Array(this.#data),
        sourceHash: this.#sourceHash,
      },
      intensity: this.#intensity,
      rotationDegrees: this.#rotationDegrees,
      requestedQuality: this.#requestedQuality,
      effectiveQuality: this.#report.effectiveQuality,
      prefilter: this.#prefilter,
      report: { ...this.#report },
    };
    const prepared = clonePrepared(this.#prepared);
    if (prepared !== undefined) {
      snapshot.prepared = prepared;
    }
    return snapshot;
  }

  copy(): ImageBasedLighting {
    return new ImageBasedLighting(
      this.#sourceCopy(),
      this.#intensity,
      this.#rotationDegrees,
      this.#requestedQuality,
      this.#prefilter,
      clonePrepared(this.#prepared),
      { ...this.#report },
    );
  }

  estimatedGpuBytes(): number {
    if (this.#prepared !== undefined) {
      return checkedSum([
        this.#prepared.irradiance.length,
        this.#prepared.specular.length,
        this.#prepared.brdfLut.length,
        IBL_UNIFORM_BYTES,
      ]);
    }
    const spec = specFor(this.#report.effectiveQuality);
    const lengths = iblPreparedLengths(spec.quality);
    return checkedSum([
      spec.environmentSize * spec.environmentSize * 6 * 8,
      lengths.irradiance,
      lengths.specular,
      lengths.brdfLut,
      IBL_UNIFORM_BYTES,
    ]);
  }

  #sourceCopy(): {
    width: number;
    height: number;
    data: Float32Array;
    sourceHash: string;
  } {
    return {
      width: this.#width,
      height: this.#height,
      data: new Float32Array(this.#data),
      sourceHash: this.#sourceHash,
    };
  }
}

export function iblFromSnapshot(snapshot: IblSnapshot): ImageBasedLighting {
  const normalized = normalizeIblSnapshot(snapshot);
  return new (ImageBasedLighting as unknown as {
    new (
      source: {
        width: number;
        height: number;
        data: Float32Array;
        sourceHash: string;
      },
      intensity: number,
      rotationDegrees: number,
      requestedQuality: IblQuality,
      prefilter: IblPrefilterMode,
      prepared: IblPrecomputedSnapshot | undefined,
      report: IblReport,
    ): ImageBasedLighting;
  })(
    {
      width: normalized.width,
      height: normalized.height,
      data: normalized.data,
      sourceHash: normalized.sourceHash,
    },
    normalized.intensity,
    normalized.rotationDegrees,
    normalized.requestedQuality,
    normalized.prefilter,
    normalized.prepared,
    normalized.report,
  );
}
