import { Forge3DError } from "./index.js";
import { createPersistentByteCache } from "./byte-cache.js";
import { VerifiedAssetStore, assetAbort } from "./verified-assets.js";
import { DATASET_CATALOG } from "./dataset-catalog.js";
import type {
  DatasetMetadata,
  DatasetKind,
  DatasetRegistryOptions,
  DatasetFetchOptions,
  DatasetDem,
  DatasetDiagnostics,
} from "./dataset-types.js";
import type { CrsGeoJson } from "./crs-types.js";
export type * from "./dataset-types.js";
const VERSION = "native-1f4084af428dc699bdcd108b029736cb73903926";
export const DATASET_BASE_URL =
  "https://media.githubusercontent.com/media/milos-agathon/forge3d/main/assets/";

/** Registry and verified byte loader. Remote format decoding belongs to W15/W16. */
export class DatasetRegistry {
  #entries = new Map<string, DatasetMetadata>();
  #store: VerifiedAssetStore | undefined;
  #storePromise: Promise<VerifiedAssetStore> | undefined;
  #active = 0;
  #disposed = false;
  readonly #options: DatasetRegistryOptions;
  constructor(options: DatasetRegistryOptions = {}) {
    this.#options = { ...options };
    // Validate resource limits before the first network or cache operation.
    for (const n of [
      options.maxAssetBytes ?? 256 * 1024 * 1024,
      options.memoryBudgetBytes ?? 64 * 1024 * 1024,
    ])
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Forge3DError(
          "INVALID_INPUT",
          "Dataset byte limits must be positive safe integers",
        );
    for (const entry of options.entries ?? DATASET_CATALOG) {
      if (
        !entry.name ||
        this.#entries.has(entry.name) ||
        !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
        !["dem", "vector", "overlay", "cityjson", "geojson", "copc"].includes(
          entry.kind,
        ) ||
        typeof entry.bundled !== "boolean" ||
        !entry.filename ||
        !entry.format ||
        !entry.relativeUrl ||
        !/^[a-zA-Z0-9_.\/-]+$/.test(entry.relativeUrl) ||
        entry.relativeUrl.startsWith("/") ||
        entry.relativeUrl
          .split("/")
          .some((part) => part === ".." || part === "." || !part)
      )
        throw new Forge3DError(
          "INVALID_INPUT",
          "Invalid or duplicate dataset metadata",
        );
      this.#entries.set(entry.name, structuredClone(entry));
    }
  }
  #guard(): void {
    if (this.#disposed)
      throw new Forge3DError(
        "RUNTIME_DISPOSED",
        "Dataset registry is disposed",
      );
  }
  info(name: string): DatasetMetadata {
    this.#guard();
    const value = this.#entries.get(name);
    if (!value)
      throw new Forge3DError("INVALID_INPUT", `Unknown dataset '${name}'`, {
        kind: "dataset-unknown",
        available: this.available(),
      });
    return structuredClone(value);
  }
  listDatasets(): DatasetMetadata[] {
    this.#guard();
    return [...this.#entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .map((v) => structuredClone(v));
  }
  datasetInfo(): Record<string, DatasetMetadata> {
    return Object.fromEntries(this.listDatasets().map((v) => [v.name, v]));
  }
  bundled(): string[] {
    return this.listDatasets()
      .filter((e) => e.bundled)
      .map((e) => e.name);
  }
  remote(): string[] {
    return this.listDatasets()
      .filter((e) => !e.bundled)
      .map((e) => e.name);
  }
  available(): string[] {
    return [...this.bundled(), ...this.remote()];
  }
  url(name: string): URL {
    const entry = this.info(name);
    const base = entry.bundled
      ? (this.#options.bundledBaseUrl ??
        new URL("../assets/datasets/", import.meta.url))
      : (this.#options.baseUrl ?? (entry.gitLfs === false
          ? "https://raw.githubusercontent.com/milos-agathon/forge3d/main/assets/"
          : DATASET_BASE_URL));
    const directory = new URL(base, import.meta.url);
    if (!directory.pathname.endsWith("/")) directory.pathname += "/";
    const result = new URL(entry.relativeUrl, directory);
    if (
      !["https:", "http:"].includes(result.protocol) ||
      result.origin !== directory.origin ||
      !result.pathname.startsWith(directory.pathname)
    )
      throw new Forge3DError(
        "INVALID_INPUT",
        "Dataset URLs must stay within the HTTP(S) base directory",
      );
    return result;
  }
  async #getStore(): Promise<VerifiedAssetStore> {
    this.#guard();
    this.#storePromise ??= (async () => {
      const cache =
        this.#options.cache === undefined
          ? await createPersistentByteCache({ name: "forge3d-w14" })
          : this.#options.cache;
      const store = new VerifiedAssetStore(
        cache,
        this.#options.maxAssetBytes ?? 256 * 1024 * 1024,
        this.#options.memoryBudgetBytes ?? 64 * 1024 * 1024,
      );
      if (this.#disposed) {
        store.dispose();
        this.#guard();
      }
      return (this.#store = store);
    })();
    return this.#storePromise;
  }
  async fetch(
    name: string,
    options: DatasetFetchOptions = {},
  ): Promise<Uint8Array> {
    this.#guard();
    assetAbort(options.signal);
    const entry = this.info(name);
    const url = this.url(name);
    this.#active++;
    try {
      const store = await this.#getStore();
      this.#guard();
      assetAbort(options.signal);
      return await store.read(
        { ...entry, url, version: entry.version ?? VERSION },
        options,
      );
    } finally {
      this.#active--;
    }
  }
  async #fetchKind(
    name: string,
    kind: DatasetKind,
    options: DatasetFetchOptions,
  ): Promise<Uint8Array> {
    const metadata = this.info(name);
    if (!metadata.bundled && metadata.kind !== kind)
      throw new Forge3DError(
        "INVALID_INPUT",
        `Dataset '${name}' has kind '${metadata.kind}', expected '${kind}'`,
        { kind: "dataset-kind", actual: metadata.kind, expected: kind },
      );
    return this.fetch(name, options);
  }
  fetchDem(
    name: string,
    options: DatasetFetchOptions = {},
  ): Promise<Uint8Array> {
    return this.#fetchKind(name, "dem", options);
  }
  fetchCityJson(
    name: string,
    options: DatasetFetchOptions = {},
  ): Promise<Uint8Array> {
    return this.#fetchKind(name, "cityjson", options);
  }
  fetchCopc(
    name: string,
    options: DatasetFetchOptions = {},
  ): Promise<Uint8Array> {
    return this.#fetchKind(name, "copc", options);
  }
  miniDemUrl(): URL {
    return this.url("mini_dem");
  }
  sampleBoundariesUrl(): URL {
    return this.url("sample_boundaries");
  }
  async miniDem(options: DatasetFetchOptions = {}): Promise<DatasetDem> {
    const bytes = await this.fetch("mini_dem", options);
    this.#guard();
    assetAbort(options.signal);
    return { ...decodeDatasetNpy(bytes), metadata: this.info("mini_dem") };
  }
  async sampleBoundaries(
    options: DatasetFetchOptions = {},
  ): Promise<CrsGeoJson> {
    const bytes = await this.fetch("sample_boundaries", options);
    this.#guard();
    assetAbort(options.signal);
    try {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as CrsGeoJson;
      if (value.type !== "FeatureCollection" || !Array.isArray(value.features))
        throw Error("Expected FeatureCollection");
      return value;
    } catch (error) {
      throw new Forge3DError("IO_ERROR", "Invalid bundled GeoJSON", {
        kind: "dataset-format",
        reason: String(error),
      });
    }
  }
  getDiagnostics(): DatasetDiagnostics {
    const stats = this.#store?.memory.stats();
    return {
      memoryBytes: stats?.bytes ?? 0,
      memoryBudgetBytes: this.#options.memoryBudgetBytes ?? 64 * 1024 * 1024,
      cachedEntries: stats?.entries ?? 0,
      activeRequests: this.#active,
      persistent: !!this.#store?.persistent,
      disposed: this.#disposed,
      gpuBytes: 0,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#store?.dispose();
  }
}

/** Safe non-executable subset of NPY: C-order little-endian 2D float32 grids. */
export function decodeDatasetNpy(
  bytes: Uint8Array,
): Omit<DatasetDem, "metadata"> {
  const invalid = (): never => {
    throw new Forge3DError(
      "IO_ERROR",
      "Expected a C-order little-endian 2D float32 NPY grid",
      { kind: "dataset-format" },
    );
  };
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x93 ||
    new TextDecoder().decode(bytes.subarray(1, 6)) !== "NUMPY"
  )
    invalid();
  const major = bytes[6]!;
  if (![1, 2, 3].includes(major) || bytes[7] !== 0) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset = major === 1 ? 10 : 12;
  if (bytes.length < offset) invalid();
  const length =
    major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  if (length > 65536 || offset + length > bytes.length) invalid();
  const header = new TextDecoder().decode(
    bytes.subarray(offset, offset + length),
  );
  if (
    !/['"]descr['"]\s*:\s*['"]<f4['"]/u.test(header) ||
    !/['"]fortran_order['"]\s*:\s*False/u.test(header)
  )
    invalid();
  const shape = /['"]shape['"]\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*,?\s*\)/u.exec(
    header,
  );
  if (!shape) invalid();
  const height = Number(shape![1]),
    width = Number(shape![2]),
    count = width * height;
  if (
    !Number.isSafeInteger(count) ||
    !width ||
    !height ||
    offset + length + count * 4 !== bytes.length
  )
    invalid();
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++)
    data[i] = view.getFloat32(offset + length + i * 4, true);
  return { data, width, height };
}
