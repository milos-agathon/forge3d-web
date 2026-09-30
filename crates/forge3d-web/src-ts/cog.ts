// W08 / DESIGN F3 — `CogDataset`, a range-scheduled, LRU-cached,
// worker-capable COG reader on top of `geotiff` (vendored, exact
// 3.0.5; `dist/vendor/geotiff.js` after `prepare-dist`).
//
// geotiff parses the TIFF header and every IFD *through our client*,
// which routes all reads through `RangeScheduler` — so dedupe /
// coalescing / 206 enforcement / cache lookup / stats apply to
// metadata and tile reads identically. Tile bytes are fetched by this
// module (never `image.readRasters`, never geotiff's `Pool`, whose
// workers use `blob:` URLs banned by our CSP) and decoded with
// `getDecoder(compression, parameters)`.

import type {
  BaseClient,
  GeoTIFF,
  GeoTIFFImage,
  ImageFileDirectory,
} from "geotiff";
import type {
  CogDatasetOptions,
  CogStats,
  Forge3DMessageHandler,
  Forge3DWorkerPool,
  IfdInfo,
  PersistentByteCache,
} from "./index.js";
import { Forge3DError } from "./index.js";
import { MemoryByteCache } from "./byte-cache.js";
import { RangeScheduler } from "./range-scheduler.js";

const MASK_FLAG = 4;

/** `signal.throwIfAborted()` normalized to the Forge3DError contract. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Forge3DError(
      "REQUEST_CANCELLED",
      "COG request was cancelled",
      { reason: "aborted" },
    );
  }
}

type Module = typeof import("geotiff");

let modulePromise: Promise<Module> | undefined;
function loadGeotiff(): Promise<Module> {
  modulePromise ??= import("geotiff");
  return modulePromise;
}

/** geotiff `BaseClient` whose request is a single range through the
 * scheduler. `RemoteSource` parses the synthesized `content-range`
 * header exactly like a server response. */
class SchedulerClient implements BaseClient {
  readonly url: string;

  constructor(
    readonly source: string | URL | Blob,
    private readonly scheduler: RangeScheduler,
  ) {
    this.url = source instanceof Blob ? `blob:${source.size}` : String(source);
  }

  async request(options: RequestInit = {}): Promise<SchedulerResponse> {
    const headers = new Headers(options.headers);
    const range = headers.get("range") ?? "";
    const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (!match) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `COG source request is not a single byte range: ${range || "(none)"}`,
        { reason: "range-required" },
      );
    }
    const offset = Number(match[1]);
    const end = match[2] ? Number(match[2]) : offset;
    const bytes = await this.scheduler.request(
      this.source,
      offset,
      end - offset + 1,
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    const total = this.scheduler.fileSize(this.source);
    return new SchedulerResponse(offset, end, bytes, total);
  }
}

class SchedulerResponse {
  get ok(): boolean {
    return true;
  }

  get status(): number {
    return 206;
  }

  readonly #headers: Record<string, string>;
  readonly #data: Uint8Array;

  constructor(offset: number, end: number, data: Uint8Array, total: number | undefined) {
    this.#data = data;
    this.#headers = {
      "content-range": `bytes ${offset}-${end}/${total === undefined ? "*" : total}`,
      "content-length": String(data.length),
    };
  }

  getHeader(name: string): string | undefined {
    return this.#headers[name.toLowerCase()];
  }

  getData(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.#data.buffer.slice(
        this.#data.byteOffset,
        this.#data.byteOffset + this.#data.byteLength,
      ) as ArrayBuffer,
    );
  }
}

interface DecodeParameters {
  tileWidth: number;
  tileHeight: number;
  planarConfiguration: number;
  bitsPerSample: number[];
  predictor: number;
  samplesPerPixel: number;
  jpegTables?: ArrayBuffer | Uint8Array;
}

/** Mirrors geotiff's `decoderParameterFns`: the shared parameters plus
 * the per-codec extras needed by jpeg and lerc. */
async function decoderParameters(fileDirectory: ImageFileDirectory): Promise<DecodeParameters> {
  const parameters: DecodeParameters = {
    tileWidth: fileDirectory.getValue("TileWidth") ?? fileDirectory.getValue("ImageWidth") ?? 0,
    tileHeight:
      fileDirectory.getValue("TileLength") ??
      fileDirectory.getValue("RowsPerStrip") ??
      fileDirectory.getValue("ImageLength") ??
      0,
    planarConfiguration: fileDirectory.getValue("PlanarConfiguration") ?? 1,
    bitsPerSample: Array.from(
      (await fileDirectory.loadValue("BitsPerSample")) as number[],
    ),
    predictor: fileDirectory.hasTag("Predictor")
      ? ((await fileDirectory.loadValue("Predictor")) as number)
      : 1,
    samplesPerPixel: fileDirectory.getValue("SamplesPerPixel") ?? 1,
  };
  if (fileDirectory.hasTag("JPEGTables")) {
    parameters.jpegTables = (await fileDirectory.loadValue(
      "JPEGTables",
    )) as Uint8Array;
  }
  return parameters;
}

function bitsFor(parameters: DecodeParameters, sample: number): number {
  const bits = parameters.bitsPerSample;
  return bits.length === 1 ? bits[0]! : bits[sample]!;
}

/** Convert one decoded tile buffer to `tileWidth*tileHeight` float32
 * samples of `band` (0-based), handling sample formats 1-3, bit
 * depths 8-64 and the file's endianness. */
function tileToFloat32(
  decoded: ArrayBuffer,
  parameters: DecodeParameters,
  sampleFormat: number[],
  band: number,
  littleEndian: boolean,
): Float32Array {
  const { tileWidth, tileHeight, planarConfiguration, samplesPerPixel } = parameters;
  const out = new Float32Array(tileWidth * tileHeight);
  const bytesPerSample = bitsFor(parameters, band) >> 3;
  const stride =
    planarConfiguration === 1 ? bytesPerSample * samplesPerPixel : bytesPerSample;
  const base = planarConfiguration === 1 ? bytesPerSample * band : 0;
  const view = new DataView(decoded);
  const format = sampleFormat.length === 1 ? sampleFormat[0]! : sampleFormat[band]!;
  const bits = bitsFor(parameters, band);
  let read: (offset: number) => number;
  if (format === 3) {
    if (bits === 16) {
      read = (offset) => float16BitsToNumber(view.getUint16(offset, littleEndian));
    } else {
      read =
        bits === 64
          ? (offset) => view.getFloat64(offset, littleEndian)
          : (offset) => view.getFloat32(offset, littleEndian);
    }
  } else {
    switch (bits) {
      case 8:
        read =
          format === 2
            ? (offset) => view.getInt8(offset)
            : (offset) => view.getUint8(offset);
        break;
      case 16:
        read =
          format === 2
            ? (offset) => view.getInt16(offset, littleEndian)
            : (offset) => view.getUint16(offset, littleEndian);
        break;
      default:
        read =
          format === 2
            ? (offset) => view.getInt32(offset, littleEndian)
            : (offset) => view.getUint32(offset, littleEndian);
    }
  }
  for (let index = 0; index < out.length; index += 1) {
    out[index] = read(base + index * stride);
  }
  return out;
}

/** IEEE-754 half → f32 decode (sampleFormat 3 + 16-bit). */
function float16BitsToNumber(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

interface LevelInfo {
  image: GeoTIFFImage;
  directory: ImageFileDirectory;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tilesAcross: number;
  tilesDown: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  sampleFormat: number[];
  compression: number;
  planar: number;
  parametersPromise: Promise<DecodeParameters>;
}

function levelInfo(image: GeoTIFFImage): LevelInfo {
  const directory = image.fileDirectory;
  const width = directory.getValue("ImageWidth") ?? image.getWidth();
  const height = directory.getValue("ImageLength") ?? image.getHeight();
  const tileWidth = directory.getValue("TileWidth") ?? width;
  const tileHeight =
    directory.getValue("TileLength") ??
    directory.getValue("RowsPerStrip") ??
    height;
  const bits = (directory.getValue("BitsPerSample") ?? 8) as
    | number
    | ArrayLike<number>;
  const bitsPerSample =
    typeof bits === "number" ? [bits] : Array.from(bits);
  const sampleFormatValue = (directory.getValue("SampleFormat") ?? 1) as
    | number
    | ArrayLike<number>;
  const sampleFormat =
    typeof sampleFormatValue === "number"
      ? [sampleFormatValue]
      : Array.from(sampleFormatValue);
  return {
    image,
    directory,
    width,
    height,
    tileWidth,
    tileHeight,
    tilesAcross: Math.ceil(width / tileWidth),
    tilesDown: Math.ceil(height / tileHeight),
    bitsPerSample,
    samplesPerPixel: directory.getValue("SamplesPerPixel") ?? 1,
    sampleFormat,
    compression: directory.getValue("Compression") ?? 1,
    planar: directory.getValue("PlanarConfiguration") ?? 1,
    parametersPromise: decoderParameters(directory),
  };
}

/** GeoTIFF `GTRasterTypeGeoKey` value for PixelIsPoint rasters. */
const RASTER_PIXEL_IS_POINT = 2;
/** GeoTIFF "user-defined" code: the CRS is not an EPSG code. */
const USER_DEFINED_GEOKEY = 32767;

function geotransformOf(
  image: GeoTIFFImage,
): [number, number, number, number, number, number] | undefined {
  const directory = image.fileDirectory;
  const transform = directory.getValue("ModelTransformation");
  let geoTransform: [number, number, number, number, number, number];
  if (transform && transform.length === 16) {
    geoTransform = [
      transform[3]!,
      transform[0]!,
      transform[1]!,
      transform[7]!,
      transform[4]!,
      transform[5]!,
    ];
  } else if (
    directory.hasTag("ModelTiepoint") ||
    directory.hasTag("ModelPixelScale")
  ) {
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    geoTransform = [origin[0]!, resolution[0]!, 0, origin[1]!, 0, resolution[1]!];
  } else {
    return undefined;
  }
  // GDAL: a PixelIsPoint tiepoint names the centre of the first pixel, so
  // the area-based origin moves back half a pixel along both axes.
  if (image.getGeoKeys()?.GTRasterTypeGeoKey === RASTER_PIXEL_IS_POINT) {
    const [x0, rx, skewX, y0, skewY, ry] = geoTransform;
    geoTransform[0] = x0 - (rx * 0.5 + skewX * 0.5);
    geoTransform[3] = y0 - (skewY * 0.5 + ry * 0.5);
  }
  return geoTransform;
}

function crsOf(image: GeoTIFFImage): string | null {
  const keys = image.getGeoKeys();
  const code = keys?.ProjectedCSTypeGeoKey ?? keys?.GeographicTypeGeoKey;
  // User-defined (32767) systems are described by other keys, not EPSG.
  if (!code || code === USER_DEFINED_GEOKEY) {
    return null;
  }
  return `EPSG:${code}`;
}

function boundsFromTransform(
  transform: [number, number, number, number, number, number],
  width: number,
  height: number,
): [number, number, number, number] {
  const [x0, rx, skewX, y0, skewY, ry] = transform;
  const corners = [
    [x0, y0],
    [x0 + rx * width + skewX * height, y0 + skewY * width + ry * height],
    [x0 + skewX * height, y0 + ry * height],
    [x0 + rx * width, y0 + skewY * width],
  ];
  const xs = corners.map((c) => c[0]!);
  const ys = corners.map((c) => c[1]!);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** W08 / DESIGN F3 — COG reader over `RangeScheduler`. Every byte of
 * the file passes through the scheduler (header, IFD tag values, tile
 * ranges), so a single-tile read transfers only its metadata prefix
 * plus the tile. Decoded tiles live in a byte-budgeted LRU. */
export class CogDataset {
  /** `fromUrl`-style identifier (`blob:<size>` for Blob sources). */
  url!: string;
  width!: number;
  height!: number;
  /** IFDs excluding masks (NewSubfileType bit 4). */
  overviewCount!: number;
  bounds!: [number, number, number, number];
  geoTransform!: [number, number, number, number, number, number] | undefined;
  crs!: string | null;
  nodata!: number | null;
  bitsPerSample!: number;
  sampleFormat!: number;
  samplesPerPixel!: number;
  compression!: number;

  private constructor(
    private readonly geotiff: GeoTIFF,
    private readonly levels: LevelInfo[],
    private readonly moduleRef: Module,
    readonly source: string | URL | Blob,
    private readonly scheduler: RangeScheduler,
    private readonly cache: MemoryByteCache,
    private readonly persistentCache: PersistentByteCache | undefined,
    private readonly pool: Forge3DWorkerPool | undefined,
    private readonly ownsScheduler: boolean,
  ) {}

  static async open(
    source: string | URL | Blob,
    options: CogDatasetOptions = {},
  ): Promise<CogDataset> {
    throwIfCancelled(options.signal);
    const scheduler =
      options.scheduler ??
      new RangeScheduler({
        ...(options.persistentCache !== undefined
          ? { persistentCache: options.persistentCache }
          : {}),
      });
    const mod = await loadGeotiff();
    const client = new SchedulerClient(source, scheduler);
    const geotiff = await mod.fromCustomClient(
      client as unknown as BaseClient,
      { maxRanges: 0, allowFullFile: false },
      options.signal,
    );
    const imageCount = await geotiff.getImageCount();
    const levels: LevelInfo[] = [];
    for (let index = 0; index < imageCount; index += 1) {
      const image = await geotiff.getImage(index);
      const newSubfileType =
        image.fileDirectory.getValue("NewSubfileType") ?? 0;
      if ((newSubfileType & MASK_FLAG) === 0) levels.push(levelInfo(image));
    }
    if (levels.length === 0) {
      throw new Forge3DError("IO_ERROR", "COG has no image IFDs", {
        reason: "cog-no-image",
      });
    }
    const dataset = new CogDataset(
      geotiff,
      levels,
      mod,
      source,
      scheduler,
      new MemoryByteCache((options.cacheSizeMb ?? 256) * 1024 * 1024),
      options.persistentCache,
      options.workerPool,
      options.scheduler === undefined,
    );
    const first = levels[0]!;
    dataset.url = client.url;
    dataset.width = first.width;
    dataset.height = first.height;
    dataset.overviewCount = levels.length;
    dataset.bitsPerSample = first.bitsPerSample[0]!;
    dataset.sampleFormat = first.sampleFormat[0]!;
    dataset.samplesPerPixel = first.samplesPerPixel;
    dataset.compression = first.compression;
    dataset.nodata = first.image.getGDALNoData();
    dataset.crs = crsOf(first.image);
    dataset.geoTransform = geotransformOf(first.image);
    dataset.bounds = dataset.geoTransform
      ? boundsFromTransform(dataset.geoTransform, first.width, first.height)
      : [0, 0, first.width, first.height];
    return dataset;
  }

  ifdInfo(level: number): IfdInfo {
    const info = this.level(level);
    return {
      width: info.width,
      height: info.height,
      tileWidth: info.tileWidth,
      tileHeight: info.tileHeight,
      tilesAcross: info.tilesAcross,
      tilesDown: info.tilesDown,
      bitsPerSample: info.bitsPerSample[0]!,
      compression: info.compression,
      tileCount: info.tilesAcross * info.tilesDown,
    };
  }

  /** Native `select_ifd_for_lod`: widest level with index <= lod. */
  selectOverview(lod: number): number {
    return Math.min(Math.max(0, lod), this.levels.length - 1);
  }

  /** Deepest overview index whose per-pixel ground size is no smaller
   * than `unitsPerPixel`; 0 when the base already suffices. */
  selectOverviewForResolution(unitsPerPixel: number): number {
    const base = this.resolutionAt(0);
    if (!(unitsPerPixel > base)) return 0;
    let level = 0;
    while (
      level + 1 < this.levels.length &&
      this.resolutionAt(level + 1) <= unitsPerPixel
    ) {
      level += 1;
    }
    return level;
  }

  private resolutionAt(level: number): number {
    const transform = this.geoTransform;
    const base = transform ? Math.abs(transform[1]) || 1 : 1;
    const ratio = this.levels[0]!.width / this.levels[level]!.width;
    return base * ratio;
  }

  private level(index: number): LevelInfo {
    const info = this.levels[index];
    if (!info) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `COG level ${index} out of range (count ${this.levels.length})`,
        { reason: "ifd-out-of-range" },
      );
    }
    return info;
  }

  /** `read_tile` semantics: tile (x,y) at `lod` (clamped via
   * `selectOverview`), returned as `tileHeight*tileWidth` float32 band
   * 0 in row-major order. A 0 byte-count (sparse) tile fills with the
   * nodata value or 0. */
  async readTile(
    x: number,
    y: number,
    lod = 0,
    options: { signal?: AbortSignal; priority?: number } = {},
  ): Promise<Float32Array> {
    const levelIndex = this.selectOverview(lod);
    const level = this.level(levelIndex);
    this.assertTileInRange(level, x, y);
    const cacheKey = `${levelIndex}/${x}/${y}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return new Float32Array(
        cached.buffer.slice(
          cached.byteOffset,
          cached.byteOffset + cached.byteLength,
        ) as ArrayBuffer,
      );
    }
    throwIfCancelled(options.signal);
    const bytes = await this.readTileSampleBytes(level, x, y, 0, options);
    const parameters = await level.parametersPromise;
    if (bytes === undefined) {
      const fill = new Float32Array(level.tileWidth * level.tileHeight);
      fill.fill(this.nodata ?? 0);
      this.cachePut(cacheKey, fill);
      // The cache keeps its own buffer; callers may mutate theirs.
      return fill.slice();
    }
    const decoded = await this.decodeBytes(level.compression, parameters, bytes);
    const float32 = tileToFloat32(
      decoded,
      parameters,
      level.sampleFormat,
      0,
      this.geotiff.littleEndian,
    );
    this.cachePut(cacheKey, float32);
    return float32.slice();
  }

  /** RGBA8 tile (x,y) at level for uint8 gray/RGB/RGBA sources;
   * other sample formats are UNSUPPORTED_FEATURE. */
  async readTileRgba(
    x: number,
    y: number,
    lod = 0,
    options: { signal?: AbortSignal; priority?: number } = {},
  ): Promise<Uint8ClampedArray> {
    const levelIndex = this.selectOverview(lod);
    const level = this.level(levelIndex);
    this.assertTileInRange(level, x, y);
    const bits = level.bitsPerSample[0]!;
    const format = level.sampleFormat[0]!;
    if (bits !== 8 || format !== 1) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `COG RGBA read requires uint8 samples (bits ${bits}, sampleFormat ${format})`,
        { reason: "cog-rgba-format" },
      );
    }
    const samples = level.samplesPerPixel;
    if (samples !== 1 && samples !== 3 && samples !== 4) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `COG RGBA read supports 1/3/4 samples, got ${samples}`,
        { reason: "cog-rgba-samples" },
      );
    }
    const pixels = level.tileWidth * level.tileHeight;
    const rgba = new Uint8ClampedArray(pixels * 4);
    const decoded = await this.decodePlanarSamples(level, x, y, options);
    if (samples === 1) {
      for (let index = 0; index < pixels; index += 1) {
        const value = decoded[0]![index]!;
        rgba[index * 4] = value;
        rgba[index * 4 + 1] = value;
        rgba[index * 4 + 2] = value;
        rgba[index * 4 + 3] = 255;
      }
    } else {
      for (let index = 0; index < pixels; index += 1) {
        rgba[index * 4] = decoded[0]![index]!;
        rgba[index * 4 + 1] = decoded[1]![index]!;
        rgba[index * 4 + 2] = decoded[2]![index]!;
        rgba[index * 4 + 3] = samples === 4 ? decoded[3]![index]! : 255;
      }
    }
    return rgba;
  }

  /** Read one full overview level as `width*height` RGBA8 (edge tiles
   * clipped). */
  async readOverviewRgba(
    level: number,
    options: { signal?: AbortSignal; priority?: number } = {},
  ): Promise<Uint8ClampedArray> {
    const info = this.level(this.selectOverview(level));
    const out = new Uint8ClampedArray(info.width * info.height * 4);
    const reads: Promise<void>[] = [];
    for (let ty = 0; ty < info.tilesDown; ty += 1) {
      for (let tx = 0; tx < info.tilesAcross; tx += 1) {
        reads.push(
          this.readTileRgba(tx, ty, level, options).then((tile) => {
            const copyWidth = Math.min(
              info.tileWidth,
              info.width - tx * info.tileWidth,
            );
            const copyHeight = Math.min(
              info.tileHeight,
              info.height - ty * info.tileHeight,
            );
            for (let row = 0; row < copyHeight; row += 1) {
              const src = row * info.tileWidth * 4;
              const dst =
                ((ty * info.tileHeight + row) * info.width +
                  tx * info.tileWidth) *
                4;
              out.set(tile.subarray(src, src + copyWidth * 4), dst);
            }
          }),
        );
      }
    }
    await Promise.all(reads);
    return out;
  }

  stats(): CogStats {
    const cache = this.cache.stats();
    const requests = cache.hits + cache.misses;
    return {
      cacheHits: cache.hits,
      cacheMisses: cache.misses,
      cacheEvictions: cache.evictions,
      memoryUsedBytes: cache.bytes,
      memoryBudgetBytes: cache.budgetBytes,
      hitRatePercent: requests === 0 ? 0 : (cache.hits / requests) * 100,
      range: this.scheduler.stats(),
      persistent: this.persistentCache?.stats() ?? null,
    };
  }

  dispose(): void {
    this.cache.clear();
    if (this.ownsScheduler) this.scheduler.dispose();
  }

  private assertTileInRange(level: LevelInfo, x: number, y: number): void {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= level.tilesAcross ||
      y >= level.tilesDown
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `COG tile (${x}, ${y}) out of range for level with ${level.tilesAcross}x${level.tilesDown} tiles`,
        { reason: "tile-out-of-range" },
      );
    }
  }

  private cachePut(key: string, values: Float32Array): void {
    this.cache.put(
      key,
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    );
  }

  /** Raw encoded tile bytes for `sample` of tile (x,y); `undefined`
   * for a sparse tile (0 byte count). */
  private async readTileSampleBytes(
    level: LevelInfo,
    x: number,
    y: number,
    sample: number,
    options: { signal?: AbortSignal; priority?: number },
  ): Promise<Uint8Array | undefined> {
    const planarIndex = x + y * level.tilesAcross;
    const tileIndex =
      level.planar === 1
        ? planarIndex
        : sample * level.tilesAcross * level.tilesDown + planarIndex;
    const directory = level.directory;
    const [offset, byteCount] = await Promise.all([
      directory.loadValueIndexed("TileOffsets", tileIndex),
      directory.loadValueIndexed("TileByteCounts", tileIndex),
    ]);
    throwIfCancelled(options.signal);
    if (byteCount === undefined || byteCount === 0) return undefined;
    return this.scheduler.request(this.source, Number(offset), Number(byteCount), {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    });
  }

  private async decodeBytes(
    compression: number,
    parameters: DecodeParameters,
    bytes: Uint8Array,
  ): Promise<ArrayBuffer> {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    if (this.pool) {
      const result = await this.pool.run<{ data: ArrayBuffer }>(
        { compression, parameters, buffer },
        { transfer: [buffer] },
      );
      return result.data;
    }
    const decoder = await this.moduleRef.getDecoder(compression, parameters);
    return (await decoder.decode(buffer)) as ArrayBuffer;
  }

  /** Decode all samples of a tile to per-sample `Float32Array`s. */
  private async decodePlanarSamples(
    level: LevelInfo,
    x: number,
    y: number,
    options: { signal?: AbortSignal; priority?: number },
  ): Promise<Float32Array[]> {
    const parameters = await level.parametersPromise;
    const pixels = level.tileWidth * level.tileHeight;
    const sparse = (): Float32Array => {
      const fill = new Float32Array(pixels);
      fill.fill(this.nodata ?? 0);
      return fill;
    };
    if (level.planar === 2) {
      const out: Float32Array[] = [];
      for (let sample = 0; sample < level.samplesPerPixel; sample += 1) {
        const bytes = await this.readTileSampleBytes(level, x, y, sample, options);
        if (bytes === undefined) {
          out.push(sparse());
        } else {
          const decoded = await this.decodeBytes(
            level.compression,
            parameters,
            bytes,
          );
          out.push(
            tileToFloat32(
              decoded,
              parameters,
              level.sampleFormat,
              sample,
              this.geotiff.littleEndian,
            ),
          );
        }
      }
      return out;
    }
    const bytes = await this.readTileSampleBytes(level, x, y, 0, options);
    if (bytes === undefined) {
      return Array.from({ length: level.samplesPerPixel }, () => sparse());
    }
    const decoded = await this.decodeBytes(level.compression, parameters, bytes);
    const out: Float32Array[] = [];
    for (let sample = 0; sample < level.samplesPerPixel; sample += 1) {
      out.push(
        tileToFloat32(
          decoded,
          parameters,
          level.sampleFormat,
          sample,
          this.geotiff.littleEndian,
        ),
      );
    }
    return out;
  }
}

/** Worker decode handler for `Forge3DWorkerPool` jobs of kind
 * `"cog-decode"` — payload `{compression, parameters, buffer}` →
 * `{data: decoded ArrayBuffer}`. Register on the pool's
 * `mainThreadHandler`/message handler alongside the other W08
 * handlers; tile decode stays on the main thread when no pool exists. */
export function createCogWorkerHandler(): Forge3DMessageHandler {
  return async (payload: unknown) => {
    const input = payload as {
      compression: number;
      parameters: DecodeParameters;
      buffer: ArrayBuffer | Uint8Array;
    };
    const mod = await loadGeotiff();
    const decoder = await mod.getDecoder(input.compression, input.parameters);
    const buffer =
      input.buffer instanceof Uint8Array
        ? input.buffer.buffer.slice(
            input.buffer.byteOffset,
            input.buffer.byteOffset + input.buffer.byteLength,
          )
        : input.buffer;
    const data = (await decoder.decode(buffer)) as ArrayBuffer;
    return { data };
  };
}
