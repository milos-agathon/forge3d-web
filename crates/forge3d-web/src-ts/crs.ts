import { Forge3DError } from "./index.js";
import { Forge3DWorkerPool } from "./browser-resources.js";
import { createPersistentByteCache } from "./byte-cache.js";
import { VerifiedAssetStore, assetAbort } from "./verified-assets.js";
import { PROJ_ASSETS } from "./proj-assets.js";
import { reprojectGeoJson } from "./crs-geometry.js";
import type {
  CrsCoordinate,
  CrsMetadata,
  CrsTransformerOptions,
  CrsTransformOptions,
  CrsDiagnostics,
  CrsGeoJson,
  CrsRasterMetadata,
  CrsGridAsset,
} from "./crs-types.js";
export type * from "./crs-types.js";

/** Lexical EPSG helper. Use parseCrs for database/WKT identification. */
export function crsToEpsg(crs: string): number | null {
  if (typeof crs !== "string") return null;
  const match = /^\s*(?:EPSG\s*:|urn:ogc:def:crs:EPSG::)(\d+)\s*$/i.exec(crs);
  if (!match) return /^\s*WGS\s*84\s*$/i.test(crs) ? 4326 : null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}
export function crsFromRasterMetadata(
  metadata: CrsRasterMetadata,
): string | null {
  if (metadata.crs) return metadata.crs;
  if (metadata.wkt) return metadata.wkt;
  const code =
    metadata.epsg ??
    metadata.geoKeys?.ProjectedCSTypeGeoKey ??
    metadata.geoKeys?.GeographicTypeGeoKey;
  return typeof code === "number" &&
    Number.isInteger(code) &&
    code > 0 &&
    code !== 32767
    ? `EPSG:${code}`
    : null;
}
export function crsFromGeoJson(input: CrsGeoJson): string {
  const crs = input.crs as { properties?: { name?: unknown } } | undefined;
  const name = crs?.properties?.name;
  return typeof name === "string" ? name : "EPSG:4326";
}
export function projAvailable(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    !!globalThis.crypto?.subtle
  );
}

/** A CPU projection worker independent of GPU/device lifetime. Dispose explicitly. */
export class CrsTransformer {
  #worker: Worker | undefined;
  #pool: Forge3DWorkerPool | undefined;
  #disposed = false;
  #pending = 0;
  #assetBytes = 0;
  #heap = 0;
  #reserved = 0;
  #budget: number;
  #grids: string[] = [];
  #assets: VerifiedAssetStore;
  #fatal: unknown;
  readonly maxPoints: number;
  private constructor(
    cache: ConstructorParameters<typeof VerifiedAssetStore>[0],
    options: CrsTransformerOptions,
  ) {
    const memory = options.memoryBudgetBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(memory) || memory < 1)
      throw new Forge3DError(
        "INVALID_INPUT",
        "memoryBudgetBytes must be a positive safe integer",
      );
    this.#budget = memory;
    this.maxPoints = options.maxPoints ?? 1_000_000;
    if (
      !Number.isSafeInteger(this.maxPoints) ||
      this.maxPoints < 1 ||
      this.maxPoints > 4_000_000
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "maxPoints must be in [1,4000000]",
      );
    this.#assets = new VerifiedAssetStore(
      cache,
      options.maxAssetBytes ?? 32 * 1024 * 1024,
      Math.min(memory, 32 * 1024 * 1024),
    );
  }
  static async create(
    options: CrsTransformerOptions = {},
  ): Promise<CrsTransformer> {
    assetAbort(options.signal);
    if (!projAvailable())
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "CRS requires Web Workers, WebAssembly and WebCrypto",
        { kind: "crs-backend-unavailable" },
      );
    const cache =
      options.cache === undefined
        ? await createPersistentByteCache({ name: "forge3d-w14" })
        : options.cache;
    const result = new CrsTransformer(cache, options);
    try {
      await result.initialize(options);
      return result;
    } catch (error) {
      result.dispose();
      throw Forge3DError.from(error);
    }
  }
  private async initialize(options: CrsTransformerOptions): Promise<void> {
    // Keep the directory URL intact: Vite's static asset rewrite drops its '/'.
    const moduleUrl = import.meta.url;
    const base = new URL("../assets/proj/", moduleUrl);
    const readOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.offline !== undefined ? { offline: options.offline } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    };
    const assets = new Map<string, Uint8Array>();
    // Sequential admission keeps peak bytes below the declared memory budget.
    for (const asset of PROJ_ASSETS.assets.filter(
      (a) => a.name !== "proj.ini",
    )) {
      const bytes = await this.#assets.read(
        {
          ...asset,
          url: new URL(asset.name, base),
          version: PROJ_ASSETS.version,
        },
        readOptions,
      );
      assets.set(asset.name, bytes);
      this.#assetBytes += bytes.length;
      this.admit();
    }
    const grids: Record<string, Uint8Array> = {};
    const entries: CrsGridAsset[] = [
      ...(options.bundledGrids === false
        ? []
        : PROJ_ASSETS.grids.map((g) => ({ ...g, url: new URL(g.name, base) }))),
      ...(options.grids ?? []),
    ];
    for (const grid of entries) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:tif|gsb|gtx|bin)$/u.test(grid.name) ||
        grid.name.includes("..") ||
        grids[grid.name]
      )
        throw new Forge3DError(
          "INVALID_INPUT",
          "Grid names must be unique safe filenames",
        );
      grids[grid.name] = await this.#assets.read(grid, readOptions);
      this.#assetBytes += grids[grid.name]!.length;
      this.admit();
    }
    this.#grids = Object.keys(grids);
    const source = new URL(import.meta.url).pathname.includes("/src-ts/");
    this.#worker = new Worker(
      new URL(source ? "./crs-worker.ts" : "./crs-worker.js", import.meta.url),
      { type: "module", name: "forge3d-proj" },
    );
    this.#worker.addEventListener("error", (event) => {
      this.#fatal = new Forge3DError(
        "WASM_LOAD_FAILED",
        event.message || "PROJ worker failed",
      );
      this.#pool?.dispose();
    });
    const channel = new MessageChannel();
    this.#pool = new Forge3DWorkerPool({
      size: 1,
      maxQueued: 32,
      workerFactory: () => channel.port1,
      mainThreadHandler: () => {
        throw new Forge3DError("UNSUPPORTED_FEATURE", "PROJ needs a worker");
      },
    });
    this.#worker.postMessage({ port: channel.port2 }, [channel.port2]);
    const wasm = assets.get("proj-emscripten.wasm")!,
      database = assets.get("proj.db")!;
    await this.run(
      {
        kind: "init",
        moduleSource: assets.get("proj-emscripten.js")!,
        wasm,
        database,
        grids,
      },
      options.signal,
      [
        wasm.buffer,
        database.buffer,
        assets.get("proj-emscripten.js")!.buffer,
        ...Object.values(grids).map((g) => g.buffer),
      ],
    );
    assetAbort(options.signal);
    this.#assets.memory.clear();
  }
  private admit(): void {
    if (this.#assetBytes * 2 + this.#heap + this.#reserved > this.#budget)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "PROJ allocations exceed memoryBudgetBytes",
        {
          assetBytes: this.#assetBytes,
          wasmHeapBytes: this.#heap,
          reservedBytes: this.#reserved,
          budgetBytes: this.#budget,
        },
      );
  }
  private guard(): void {
    if (this.#disposed)
      throw new Forge3DError("RUNTIME_DISPOSED", "CRS transformer is disposed");
    if (this.#fatal) throw this.#fatal;
  }
  private async run<T>(
    payload: unknown,
    signal?: AbortSignal,
    transfer?: Transferable[],
  ): Promise<T> {
    this.guard();
    assetAbort(signal);
    this.#pending++;
    try {
      const response = await this.#pool!.run<{ result: T; heapBytes: number }>(
        payload,
        { ...(signal ? { signal } : {}), ...(transfer ? { transfer } : {}) },
      );
      this.guard();
      this.#heap = response.heapBytes;
      this.admit();
      return response.result;
    } catch (error) {
      if (this.#fatal) throw this.#fatal;
      throw error;
    } finally {
      this.#pending--;
    }
  }
  async parseCrs(
    definition: string,
    options: Pick<CrsTransformOptions, "signal"> = {},
  ): Promise<CrsMetadata> {
    return this.run({ kind: "metadata", definition }, options.signal);
  }
  async parseCrsFromWkt(
    wkt: string,
    options: Pick<CrsTransformOptions, "signal"> = {},
  ): Promise<string | null> {
    try {
      const value = await this.parseCrs(wkt, options);
      return value.epsg === null ? wkt : `EPSG:${value.epsg}`;
    } catch (error) {
      if (error instanceof Forge3DError && error.code === "INVALID_INPUT")
        return null;
      throw error;
    }
  }
  transformCoords(
    coords: readonly CrsCoordinate[],
    source: string,
    target: string,
    options?: CrsTransformOptions,
  ): Promise<number[][]>;
  transformCoords(
    coords: Float32Array | Float64Array,
    source: string,
    target: string,
    options?: CrsTransformOptions,
  ): Promise<Float64Array>;
  async transformCoords(
    coords: readonly CrsCoordinate[] | Float32Array | Float64Array,
    source: string,
    target: string,
    options: CrsTransformOptions = {},
  ): Promise<number[][] | Float64Array> {
    return this.transform(coords, source, target, options);
  }
  transformPipeline(
    coords: readonly CrsCoordinate[],
    pipeline: string,
    options?: CrsTransformOptions,
  ): Promise<number[][]>;
  transformPipeline(
    coords: Float32Array | Float64Array,
    pipeline: string,
    options?: CrsTransformOptions,
  ): Promise<Float64Array>;
  async transformPipeline(
    coords: readonly CrsCoordinate[] | Float32Array | Float64Array,
    pipeline: string,
    options: CrsTransformOptions = {},
  ): Promise<number[][] | Float64Array> {
    this.guard();
    assetAbort(options.signal);
    if (
      typeof pipeline !== "string" ||
      !/(?:^|\s)\+?proj=pipeline(?:\s|$)/u.test(pipeline) ||
      pipeline.length > 65536 ||
      pipeline.includes("\0")
    )
      throw new Forge3DError("INVALID_INPUT", "Expected a PROJ pipeline");
    for (const match of pipeline.matchAll(
      /(?:\+?(?:grids|nadgrids|geoidgrids))=([^\s]+)/gu,
    ))
      for (const name of match[1]!.split(",")) {
        if (!this.#grids.includes(name))
          throw new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "Required grid is unavailable",
            { kind: "crs-missing-grid", grids: [name], networkEnabled: false },
          );
      }
    return this.transform(coords, "", "", options, pipeline);
  }
  private async transform(
    coords: readonly CrsCoordinate[] | Float32Array | Float64Array,
    source: string,
    target: string,
    options: CrsTransformOptions,
    pipeline?: string,
  ): Promise<number[][] | Float64Array> {
    this.guard();
    assetAbort(options.signal);
    const nested = Array.isArray(coords),
      stride = options.stride ?? (nested ? (coords[0]?.length ?? 2) : 2);
    if (
      ![2, 3, 4].includes(stride) ||
      typeof (options.alwaysXY ?? true) !== "boolean"
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "Coordinate stride must be 2, 3 or 4; alwaysXY must be boolean",
      );
    if (
      !nested &&
      !(coords instanceof Float32Array) &&
      !(coords instanceof Float64Array)
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "Expected coordinate tuples or a float array",
      );
    if (
      nested &&
      (coords as readonly CrsCoordinate[]).some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== stride ||
          p.some((n) => typeof n !== "number" || !Number.isFinite(n)),
      )
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "coords must have shape (N, stride) with finite numeric ordinates",
      );
    const count = nested ? coords.length : coords.length / stride;
    if (!Number.isInteger(count))
      throw new Forge3DError(
        "INVALID_INPUT",
        "coords must have shape (N, stride)",
      );
    if (count > this.maxPoints)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Coordinate batch exceeds maxPoints",
      );
    const reservation = count * (32 + stride * 16);
    this.#reserved += reservation;
    try {
      this.admit();
      const data = nested
        ? Float64Array.from((coords as readonly CrsCoordinate[]).flat())
        : Float64Array.from(coords as Float64Array);
      if (data.length % stride || data.some((x) => !Number.isFinite(x)))
        throw new Forge3DError(
          "INVALID_INPUT",
          "Coordinate tuples must contain finite numbers",
        );
      const result = await this.run<Float64Array>(
        {
          kind: pipeline ? "pipeline" : "transform",
          coords: data,
          source,
          target,
          stride,
          alwaysXY: options.alwaysXY ?? true,
          ...(pipeline ? { pipeline } : {}),
        },
        options.signal,
        [data.buffer],
      );
      if (!nested) return result;
      return Array.from({ length: result.length / stride }, (_, i) =>
        Array.from(result.subarray(i * stride, (i + 1) * stride)),
      );
    } finally {
      this.#reserved -= reservation;
    }
  }
  reprojectGeometry<T extends CrsGeoJson>(
    geometry: T,
    source: string,
    target: string,
    options: CrsTransformOptions = {},
  ): Promise<T> {
    this.guard();
    return reprojectGeoJson(this, geometry, source, target, options);
  }
  getDiagnostics(): CrsDiagnostics {
    return {
      backend: "proj-wasm",
      version: "0.1.0-alpha9",
      workerCount: this.#disposed ? 0 : 1,
      pendingCalls: this.#pending,
      assetBytes: this.#disposed ? 0 : this.#assetBytes,
      wasmHeapBytes: this.#disposed ? 0 : this.#heap,
      reservedBytes: this.#reserved,
      memoryBudgetBytes: this.#budget,
      gpuBytes: 0,
      disposed: this.#disposed,
      networkEnabled: false,
      grids: [...this.#grids],
      maxPoints: this.maxPoints,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pool?.dispose();
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#assets.dispose();
    this.#heap = 0;
    this.#assetBytes = 0;
  }
}
