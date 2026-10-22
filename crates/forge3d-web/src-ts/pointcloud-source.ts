import {SourceEntities,entityIfMatch} from "./source-entity.js";
import { Forge3DError } from "./runtime-failure.js";
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
import { lazAdmissionBytes, withLazAdmission, LAZ_DEFAULT_TIMEOUT_MS } from "./laz-admission.js";
import { parseLasHeader } from "./pointcloud-las.js";
import { validateLazDecode } from "./laz-decoder-local.js";
import type { PointCloudWorkerRequest } from "./pointcloud.js";
import { getWorkerJobTimeoutMs } from "./browser-resources.js";
/** Dataset lifecycle, split compressed/decoded budgets and cancellable W02 worker dispatch. */
export class PointSource {
  readonly scheduler: RangeScheduler;
  readonly entities:SourceEntities;
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
    this.entities=new SourceEntities(this.compressed,options.persistentCache,true);
    this.scheduler = new RangeScheduler({
      entities:this.entities,
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
      sourceKey=`url:${url}`,
      validator=await this.entities.validator(sourceKey),
      key = `point-file:${url}|${validator??"none"}`,
      cached =
        this.compressed.get(key) ??
        (await this.options.persistentCache?.get(key));
    pointCancelled(s);
    this.entities.check(sourceKey);
    if (cached) {
      pointLimit(cached.length, this.maxBytes);
      return cached;
    }
    try {
      const match=entityIfMatch(validator),headers:Record<string,string>=match?{"If-Match":match}:{};
      const response = await (this.options.fetch
        ? this.options.fetch(url, { headers, signal: s })
        : fetch(url, { headers, signal: s }));
      if(response.status===412){await response.body?.cancel();await this.entities.invalidate(sourceKey);}
      const bytes = await readByteSource(response, {
        maxBytes: this.maxBytes,
        signal: s,
      });
      pointCancelled(s);
      pointLive(this.disposed);
      await this.entities.observe(sourceKey,response.headers,bytes.length,"whole");
      const storedKey=`point-file:${url}|${this.entities.current(sourceKey)??"none"}`;
      this.entities.track(sourceKey,storedKey);
      this.compressed.put(storedKey, bytes);
      await this.options.persistentCache?.put(storedKey, bytes);
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
    const dispatch = async () => pool
      ? (native && pool.getDiagnostics().mode === "main-thread"
        ? await main(s)
        : native
          ? await this.#decodeNative(request as PointCloudWorkerRequest, s)
          : ((await pool.run(request, { signal: s })) as PointData))
      : await main(s);
    const result = await dispatch();
    pointCancelled(s);
    pointLive(this.disposed);
    pointLimit(pointDataBytes(result), this.maxBytes);
    return result;
  }
  async #decodeNative(request: PointCloudWorkerRequest, signal: AbortSignal): Promise<PointData> {
    if (request.kind === "ept-binary") throw new Error("Expected native LAZ request");
    const chunk = request.kind === "laz-chunk",
      header = chunk ? request.header : parseLasHeader(request.bytes),
      count = chunk ? request.count : header.pointCount;
    // Uncompressed LAS has no native heap and keeps the ordinary worker path.
    if (!header.compressed)
      return await this.options.workerPool!.run(request, { signal }) as PointData;
    validateLazDecode(request.bytes, header, count, chunk,
      { signal, ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}) });
    const pool = this.options.workerPool!, timeoutMs = Math.min(LAZ_DEFAULT_TIMEOUT_MS,
      getWorkerJobTimeoutMs(pool) ?? LAZ_DEFAULT_TIMEOUT_MS);
    return withLazAdmission(lazAdmissionBytes(request.bytes.length, header.recordLength, count, request.bytes.buffer.byteLength), { signal, timeoutMs },
      async (admittedSignal, remainingMs) => await pool.run(request,
        { signal: admittedSignal, timeoutMs: remainingMs, requireHardStop: true }) as PointData);
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
