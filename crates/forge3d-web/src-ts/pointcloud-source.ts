import { Forge3DError } from "./index.js";
import type { PointDatasetOptions, PointData } from "./pointcloud-types.js";
import { RangeScheduler } from "./range-scheduler.js";
import { MemoryByteCache } from "./byte-cache.js";
import { readByteSource } from "./browser-io.js";
import {
  PointCache,
  pointLive,
  pointCancelled,
  pointLimit,
  pointInteger,
  POINT_MAX_BYTES,
} from "./pointcloud-common.js";
import { pointDataBytes, clonePointData } from "./pointcloud-buffer.js";
/** Dataset lifecycle, split compressed/decoded budgets and cancellable W02 worker dispatch. */
export class PointSource {
  readonly scheduler: RangeScheduler;
  readonly decoded: PointCache<PointData>;
  readonly compressed: MemoryByteCache;
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxPoints: number;
  readonly abort = new AbortController();
  disposed = false;
  constructor(readonly options: PointDatasetOptions = {}) {
    this.maxBytes = options.maxBytes ?? POINT_MAX_BYTES;
    this.maxNodes = options.maxNodes ?? 100_000;
    this.maxPoints = options.maxPoints ?? 5_000_000;
    pointInteger(this.maxBytes, "maxBytes", 1);
    pointInteger(this.maxNodes, "maxNodes", 1);
    pointInteger(this.maxPoints, "maxPoints", 1);
    const cache = options.cacheBytes ?? 64 * 1024 * 1024;
    pointInteger(cache, "cacheBytes", 2);
    this.compressed = new MemoryByteCache(Math.floor(cache / 2));
    this.decoded = new PointCache(cache - Math.floor(cache / 2));
    this.scheduler = new RangeScheduler({
      memoryCache: this.compressed,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.persistentCache
        ? { persistentCache: options.persistentCache }
        : {}),
      maxCoalescedBytes: this.maxBytes,
    });
  }
  signal(signal?: AbortSignal): AbortSignal {
    pointLive(this.disposed);
    const all = [
      this.abort.signal,
      ...(this.options.signal ? [this.options.signal] : []),
      ...(signal ? [signal] : []),
    ];
    const s = AbortSignal.any(all);
    pointCancelled(s);
    return s;
  }
  async range(
    source: string | URL | Blob,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    pointLimit(length, this.maxBytes);
    return this.scheduler.request(source, offset, length, {
      signal: this.signal(signal),
    });
  }
  async read(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const s = this.signal(signal),
      key = `point-file:${url}`,
      cached =
        this.compressed.get(key) ??
        (await this.options.persistentCache?.get(key));
    pointCancelled(s);
    if (cached) {
      pointLimit(cached.length, this.maxBytes);
      return cached;
    }
    try {
      const response = await (this.options.fetch
        ? this.options.fetch(url, { headers: {}, signal: s })
        : fetch(url, { signal: s }));
      const bytes = await readByteSource(response, {
        maxBytes: this.maxBytes,
        signal: s,
      });
      pointCancelled(s);
      pointLive(this.disposed);
      this.compressed.put(key, bytes);
      await this.options.persistentCache?.put(key, bytes);
      return bytes;
    } catch (e) {
      pointCancelled(s);
      if (e instanceof Forge3DError) throw e;
      throw new Forge3DError(
        "IO_ERROR",
        "Point/tile resource could not be read",
        { url, message: String(e) },
      );
    }
  }
  async decode(
    request: unknown,
    main: (signal: AbortSignal) => Promise<PointData>,
    signal?: AbortSignal,
  ): Promise<PointData> {
    const s = this.signal(signal),
      pool = this.options.workerPool;
    const kind = (request as { kind?: unknown } | undefined)?.kind;
    const native = kind === "laz-file" || kind === "laz-chunk";
    const result = pool
      ? (native && pool.getDiagnostics().mode === "main-thread"
        ? await main(s)
        : ((await pool.run(request, { signal: s, requireHardStop: native })) as PointData))
      : await main(s);
    pointCancelled(s);
    pointLive(this.disposed);
    pointLimit(pointDataBytes(result), this.maxBytes);
    return result;
  }
  cached(key: string): PointData | undefined {
    pointLive(this.disposed);
    const p = this.decoded.get(key);
    return p ? clonePointData(p) : undefined;
  }
  admit(key: string, data: PointData): PointData {
    pointLive(this.disposed);
    this.decoded.put(key, data, pointDataBytes(data));
    return clonePointData(data);
  }
  stats() {
    return {
      ranges: this.scheduler.stats(),
      compressed: this.compressed.stats(),
      decoded: this.decoded.stats(),
      disposed: this.disposed,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.scheduler.dispose();
    this.compressed.clear();
    this.decoded.clear();
  }
}
