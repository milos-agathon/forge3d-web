import type { BrowserByteSource, ByteReadOptions, ExrImage, RgbeImage, TextureImageSnapshot, TextureSemantic, TextureFormatCapabilities } from './index.js';
import type { PointData } from './pointcloud-types.js';
import type { GltfAsset } from './mesh-gltf.js';
import type { GlyphRange } from './style-assets.js';
import type { PersistentByteStore } from './byte-cache.js';

export type CodecFormat = 'tiff' | 'laz' | 'ktx2' | 'hdr' | 'exr' | 'glb' | 'glyph-pbf';
export interface CodecRaster {
  width: number;
  height: number;
  /** TIFF band zero, row-major, including nodata samples. */
  data: Float32Array;
  nodata: number | null;
  crs: string | null;
}
export interface CodecValues {
  tiff: CodecRaster;
  laz: PointData;
  ktx2: TextureImageSnapshot;
  hdr: RgbeImage;
  exr: ExrImage;
  glb: GltfAsset;
  'glyph-pbf': GlyphRange[];
}
export interface CodecDependency {
  id: string;
  version: string;
  sha256: string;
}
export interface CodecDescriptor {
  id: string;
  format: CodecFormat;
  owner: string;
  revision: string;
  dependencies: readonly CodecDependency[];
}
export type CodecSelection =
  | { status: 'selected'; codec: CodecDescriptor }
  | { status: 'unavailable'; format: string; code: 'UNSUPPORTED_FEATURE'; reason: 'codec-not-registered' | 'codec-disabled' | 'webassembly-unavailable' | 'worker-hard-stop-unavailable' };

/** Only serializable, output-affecting options enter cache keys. */
export interface CodecParameters {
  overview?: number;
  semantic?: TextureSemantic;
  capabilities?: TextureFormatCapabilities;
}
export interface CodecDecodeOptions extends ByteReadOptions {
  parameters?: CodecParameters;
}
export interface CodecReplayOptions<F extends CodecFormat = CodecFormat> {
  /** Required to narrow the result type; checked against the cached header. */
  format: F;
  signal?: AbortSignal;
}
export interface CodecRegistryOptions {
  maxInputBytes?: number;
  maxDecodedBytes?: number;
  /** Admission bound for registry-owned transient copies and decoded output. */
  maxWorkingBytes?: number;
  /** Includes the managed persistent index and artifacts; default 64 MiB. */
  persistentCacheBytes?: number;
  cacheBytes?: number;
  maxConcurrent?: number;
  /** W02 storage adapter; owned by the application and retained after disposal. */
  store?: PersistentByteStore;
  disabled?: readonly CodecFormat[];
}
export interface CodecResult<F extends CodecFormat = CodecFormat> {
  codec: CodecDescriptor;
  value: CodecValues[F];
  /** Content, parameters and implementation versions, independent of source URL. */
  cacheKey: string;
}
export interface CodecRegistryStats {
  disposed: boolean;
  activeOperations: number;
  cacheBytes: number;
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
  workingBytes: number;
  peakWorkingBytes: number;
  workingBudgetBytes: number;
  persistentBytes: number;
  persistentEntries: number;
}
export type CodecSource = BrowserByteSource;
