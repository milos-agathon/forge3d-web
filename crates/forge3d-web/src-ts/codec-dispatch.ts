// Feature owners retain the decoders. This module only validates and dispatches.
import { Forge3DError } from './index.js';
import type { CodecFormat, CodecParameters, CodecValues, CodecRaster } from './codec-types.js';

export function codecFailure(code: ConstructorParameters<typeof Forge3DError>[0], reason: string, message: string, format?: string): Forge3DError {
  return new Forge3DError(code, message, { scope: 'codec', reason, ...(format ? { format } : {}) });
}
export function checkCodecBytes(bytes: number, limit: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
    throw codecFailure('RESOURCE_LIMIT_EXCEEDED', 'decoded-byte-limit', `Codec output requires ${bytes} bytes; limit is ${limit}`);
}
/** Counts backing views once; results never retain a dataset, worker or GPU object. */
export function decodedBytes(value: unknown, seen = new Set<ArrayBufferLike>()): number {
  if (ArrayBuffer.isView(value)) {
    if (seen.has(value.buffer)) return 0;
    seen.add(value.buffer);
    return value.buffer.byteLength;
  }
  if (Array.isArray(value)) return value.reduce((n, v) => n + decodedBytes(v, seen), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((n, v) => n + decodedBytes(v, seen), 0);
  return 0;
}
export function normalizeCodecParameters(format: CodecFormat, input: CodecParameters = {}): CodecParameters {
  const allowed = format === 'tiff' ? ['overview'] : format === 'ktx2' ? ['semantic', 'capabilities'] : [];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)))
    throw codecFailure('INVALID_INPUT', 'invalid-codec-parameters', 'Unknown codec parameters', format);
  if (format === 'tiff') {
    const overview = input.overview ?? 0;
    if (!Number.isSafeInteger(overview) || overview < 0) throw codecFailure('INVALID_INPUT', 'invalid-codec-parameters', 'overview must be a non-negative integer', format);
    return { overview };
  }
  if (format === 'ktx2') {
    const semantic = input.semantic ?? 'base-color';
    if (!['base-color','normal','metallic-roughness','occlusion','emissive'].includes(semantic)) throw codecFailure('INVALID_INPUT', 'invalid-codec-parameters', 'Unknown texture semantic', format);
    const caps = input.capabilities ?? { bc: false, etc2: false, astc: false };
    if (!caps || ['bc','etc2','astc'].some(k => typeof caps[k as keyof typeof caps] !== 'boolean') || Object.keys(caps).some(k => !['bc','etc2','astc'].includes(k)))
      throw codecFailure('INVALID_INPUT', 'invalid-codec-parameters', 'Texture capabilities must be bc/etc2/astc booleans', format);
    return { semantic, capabilities: { bc: caps.bc, etc2: caps.etc2, astc: caps.astc } };
  }
  return {};
}

function exrBound(bytes: Uint8Array, limit: number): void {
  const bad = () => codecFailure('INVALID_INPUT', 'corrupt-input', 'Invalid EXR header', 'exr');
  if (bytes.length < 9 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 20000630) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 8, pixels = 0, channels = 0;
  const name = () => {
    const start = cursor;
    while (cursor < bytes.length && cursor - start <= 255 && bytes[cursor] !== 0) cursor++;
    if (cursor >= bytes.length || cursor - start > 255) throw bad();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, cursor++));
  };
  while (cursor < bytes.length && bytes[cursor] !== 0) {
    const attribute = name(), type = name();
    if (cursor + 4 > bytes.length) throw bad();
    const size = view.getUint32(cursor, true); cursor += 4;
    const end = cursor + size;
    if (end > bytes.length) throw bad();
    if (attribute === 'dataWindow' && type === 'box2i') {
      if (size !== 16) throw bad();
      const width = view.getInt32(cursor + 8, true) - view.getInt32(cursor, true) + 1;
      const height = view.getInt32(cursor + 12, true) - view.getInt32(cursor + 4, true) + 1;
      if (width < 1 || height < 1) throw bad();
      pixels = width * height;
    } else if (attribute === 'channels' && type === 'chlist') {
      while (cursor < end && bytes[cursor] !== 0) {
        name(); cursor += 16; channels++;
        if (cursor >= end || channels > 64) throw bad();
      }
    }
    cursor = end;
  }
  if (!pixels || !channels || cursor >= bytes.length) throw bad();
  checkCodecBytes(pixels * channels * 4, limit);
}

async function tiff(bytes: Uint8Array, parameters: CodecParameters, limit: number, signal: AbortSignal): Promise<CodecRaster> {
  const { CogDataset } = await import('./cog.js');
  // Each Blob gets its own scheduler/cache; W08's blob:size identifier never crosses jobs.
  const dataset = await CogDataset.open(new Blob([bytes as BlobPart]), { signal, cacheSizeMb: 1 });
  try {
    const overview = parameters.overview ?? 0;
    if (overview >= dataset.overviewCount) throw codecFailure('INVALID_INPUT', 'invalid-codec-parameters', 'TIFF overview does not exist', 'tiff');
    const info = dataset.ifdInfo(overview);
    checkCodecBytes((info.width * info.height + info.tileWidth * info.tileHeight) * 4, limit);
    const data = new Float32Array(info.width * info.height);
    for (let y = 0; y < info.tilesDown; y++) for (let x = 0; x < info.tilesAcross; x++) {
      signal.throwIfAborted();
      const tile = await dataset.readTile(x, y, overview, { signal });
      const width = Math.min(info.tileWidth, info.width - x * info.tileWidth);
      const height = Math.min(info.tileHeight, info.height - y * info.tileHeight);
      for (let row = 0; row < height; row++) data.set(tile.subarray(row * info.tileWidth, row * info.tileWidth + width), (y * info.tileHeight + row) * info.width + x * info.tileWidth);
    }
    return { width: info.width, height: info.height, data, nodata: dataset.nodata, crs: dataset.crs };
  } finally { dataset.dispose(); }
}

export async function dispatchCodec<F extends CodecFormat>(format: F, bytes: Uint8Array, parameters: CodecParameters, limit: number, signal: AbortSignal): Promise<CodecValues[F]> {
  let value: CodecValues[CodecFormat];
  switch (format) {
    case 'tiff': value = await tiff(bytes, parameters, limit, signal); break;
    case 'laz': {
      const { decodeLaz } = await import('./laz-decoder.js');
      value = await decodeLaz(bytes, { signal, maxBytes: limit }); break;
    }
    case 'ktx2': {
      const magic = [171,75,84,88,32,50,48,187,13,10,26,10];
      if (bytes.length < 80 || magic.some((n,i) => bytes[i] !== n)) throw codecFailure('INVALID_INPUT', 'corrupt-input', 'Invalid KTX2 header', format);
      if (bytes.length >= 48) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        // Conservative RGBA mip bound also covers all supported block targets.
        checkCodecBytes(view.getUint32(20, true) * Math.max(1, view.getUint32(24, true)) * 8, limit);
      }
      const { Ktx2Loader } = await import('./textures.js');
      value = await new Ktx2Loader().load(bytes, { semantic: parameters.semantic!, capabilities: parameters.capabilities!, signal, maxBytes: Math.max(bytes.length, limit) }); break;
    }
    case 'hdr': {
      value = (await import('./ibl.js')).decodeRgbeWithLimit(bytes, limit); break;
    }
    case 'exr': {
      exrBound(bytes, limit);
      value = await (await import('./frames.js')).readExr(bytes, { maxPixels: Math.max(1, Math.floor(limit / 16)) }); break;
    }
    case 'glb': {
      if (bytes.length < 12 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x46546c67) throw codecFailure('INVALID_INPUT', 'corrupt-input', 'Invalid GLB header', format);
      // A self-contained GLB cannot request ambient URLs during replay.
      value = await (await import('./mesh-gltf.js')).decodeGltf(bytes, { signal, maxBytes: limit, resolveUri: async () => { throw codecFailure('UNSUPPORTED_FEATURE', 'external-resource-required', 'Use W15 loadGltf with an application resolver for external resources', format); } }); break;
    }
    case 'glyph-pbf': {
      value = (await import('./style-assets.js')).decodeGlyphRanges(bytes);
      if (value.length === 0) throw codecFailure('INVALID_INPUT', 'corrupt-input', 'Glyph PBF contains no font stack', format);
      break;
    }
    default: throw codecFailure('UNSUPPORTED_FEATURE', 'codec-not-registered', 'Unknown codec', format);
  }
  checkCodecBytes(decodedBytes(value), limit);
  return value as CodecValues[F];
}
