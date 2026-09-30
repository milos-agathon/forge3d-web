// W08/T09-T10 byte caches (F2): an in-memory LRU plus persistent
// digest-verified adapters (OPFS, IndexedDB, CacheStorage) following the
// `IblCache` backend patterns in `ibl.ts`.
//
// Persistent entries are framed as `sha256(data) (32 bytes) || data`; a
// digest mismatch deletes the entry, bumps `checksumFailures` and reads as
// a miss, so corrupted bytes are never served. Cache keys are built by the
// caller (`RangeScheduler` folds the captured resource validator into the
// key so stale bytes never hit).

import { Forge3DError } from "./index.js";
import type {
  MemoryByteCacheStats,
  PersistentByteCache,
  PersistentByteCacheStats,
} from "./index.js";

/** Minimal key/value storage a persistent adapter writes framed entries to. */
export interface PersistentByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

const DIGEST_BYTES = 32;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = (
    globalThis as typeof globalThis & { crypto?: { subtle?: SubtleCrypto } }
  ).crypto?.subtle;
  if (subtle === undefined) {
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "crypto.subtle SHA-256 is unavailable; persistent byte caches require a secure context",
    );
  }
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

async function frame(bytes: Uint8Array): Promise<Uint8Array> {
  const encoded = new Uint8Array(DIGEST_BYTES + bytes.byteLength);
  encoded.set(await sha256(bytes));
  encoded.set(bytes, DIGEST_BYTES);
  return encoded;
}

function unframe(stored: Uint8Array): Uint8Array | undefined {
  if (stored.length <= DIGEST_BYTES) {
    return undefined;
  }
  return stored.slice(DIGEST_BYTES);
}

/** In-memory LRU byte cache with a byte budget and observable stats. */
export class MemoryByteCache {
  readonly #budgetBytes: number;
  readonly #entries = new Map<string, { bytes: Uint8Array; size: number }>();
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #bytes = 0;

  constructor(budgetBytes: number) {
    if (
      !Number.isSafeInteger(budgetBytes) ||
      budgetBytes <= 0
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "memory byte cache budgetBytes must be a positive safe integer",
      );
    }
    this.#budgetBytes = budgetBytes;
  }

  get budgetBytes(): number {
    return this.#budgetBytes;
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits += 1;
    return entry.bytes;
  }

  /** Non-stat peek used to warm lookups without a miss/hit churn. */
  peek(key: string): Uint8Array | undefined {
    return this.#entries.get(key)?.bytes;
  }

  put(key: string, bytes: Uint8Array): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#bytes -= existing.size;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { bytes, size: bytes.byteLength });
    this.#bytes += bytes.byteLength;
    while (this.#bytes > this.#budgetBytes && this.#entries.size > 0) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#remove(oldest);
    }
  }

  delete(key: string): boolean {
    return this.#remove(key);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  stats(): MemoryByteCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      bytes: this.#bytes,
      budgetBytes: this.#budgetBytes,
      entries: this.#entries.size,
    };
  }

  #remove(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.#entries.delete(key);
    this.#bytes -= entry.size;
    this.#evictions += 1;
    return true;
  }
}

/**
 * Digest-framed persistent byte cache over an injectable
 * {@link PersistentByteStore}. Verification failures delete the entry and
 * count as misses.
 */
export class DigestCheckedByteCache implements PersistentByteCache {
  readonly kind: string;
  readonly #store: PersistentByteStore;
  #hits = 0;
  #misses = 0;
  #checksumFailures = 0;
  #entriesWritten = 0;
  #bytesWritten = 0;

  constructor(kind: string, store: PersistentByteStore) {
    this.kind = kind;
    this.#store = store;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const stored = await this.#store.get(key);
    if (stored === undefined) {
      this.#misses += 1;
      return undefined;
    }
    const data = unframe(stored);
    if (
      data === undefined ||
      !digestsEqual(await sha256(data), stored.slice(0, DIGEST_BYTES))
    ) {
      this.#checksumFailures += 1;
      this.#misses += 1;
      await this.#store.delete(key);
      return undefined;
    }
    this.#hits += 1;
    return data;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.#store.put(key, await frame(bytes));
    this.#entriesWritten += 1;
    this.#bytesWritten += bytes.byteLength;
  }

  async delete(key: string): Promise<void> {
    await this.#store.delete(key);
  }

  async clear(): Promise<void> {
    await this.#store.clear();
  }

  stats(): PersistentByteCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      checksumFailures: this.#checksumFailures,
      entries: this.#entriesWritten,
      bytes: this.#bytesWritten,
    };
  }
}

interface OpfsWritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface OpfsFileHandleLike {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<OpfsWritableLike>;
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
  removeEntry?(name: string): Promise<void>;
}

function opfsRoot():
  | (() => Promise<OpfsDirectoryHandleLike>)
  | undefined {
  const navigatorLike = (
    globalThis as typeof globalThis & {
      navigator?: {
        storage?: { getDirectory?: () => Promise<OpfsDirectoryHandleLike> };
      };
    }
  ).navigator;
  const getDirectory = navigatorLike?.storage?.getDirectory;
  if (typeof getDirectory === "function") {
    return () => getDirectory.call(navigatorLike.storage);
  }
  return undefined;
}

function sanitizeKey(key: string): string {
  return encodeURIComponent(key).replace(/%/g, "~");
}

export function opfsByteStore(namespace: string): PersistentByteStore {
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
      try {
        const file = await dir.getFileHandle(sanitizeKey(key));
        const blob = await file.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async put(key, value) {
      const dir = await directory();
      if (dir === undefined) {
        return;
      }
      const file = await dir.getFileHandle(sanitizeKey(key), {
        create: true,
      });
      const writable = await file.createWritable();
      await writable.write(value);
      await writable.close();
    },
    async delete(key) {
      const dir = await directory();
      if (dir === undefined || dir.removeEntry === undefined) {
        return;
      }
      try {
        await dir.removeEntry(sanitizeKey(key));
      } catch {
        // Missing entries are already deleted.
      }
    },
    async clear() {
      const dir = await directory();
      if (dir === undefined || dir.removeEntry === undefined) {
        return;
      }
      // OPFS lacks a directory enumeration in the minimal handle surface;
      // drop the namespace entirely and recreate it lazily.
      try {
        const root = opfsRoot();
        if (root === undefined) {
          return;
        }
        const parent = await root();
        await parent.removeEntry?.(namespace);
      } catch {
        // Clearing is best-effort.
      }
    },
  };
}

interface IdbRequestLike<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface IdbStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
  clear(): IdbRequestLike<unknown>;
}

interface IdbTransactionLike {
  objectStore(name: string): IdbStoreLike;
}

interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): IdbStoreLike;
  transaction(name: string, mode: string): IdbTransactionLike;
  close(): void;
}

interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((event: unknown) => void) | null;
}

interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

function indexedDbFactory(): IdbFactoryLike | undefined {
  const candidate = (
    globalThis as typeof globalThis & { indexedDB?: IdbFactoryLike }
  ).indexedDB;
  if (candidate !== undefined && typeof candidate.open === "function") {
    return candidate;
  }
  return undefined;
}

function idbRequest<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

const IDB_STORE_NAME = "entries";

export function indexedDbByteStore(namespace: string): PersistentByteStore {
  let opened: Promise<IdbDatabaseLike> | undefined;
  const database = () => {
    opened ??= (async () => {
      const factory = indexedDbFactory();
      if (factory === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "IndexedDB is unavailable",
        );
      }
      const request = factory.open(namespace, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME);
        }
      };
      return idbRequest(request);
    })();
    return opened;
  };
  const store = async (mode: "readonly" | "readwrite") => {
    const db = await database();
    return db.transaction(IDB_STORE_NAME, mode).objectStore(IDB_STORE_NAME);
  };
  return {
    async get(key) {
      const value = await idbRequest((await store("readonly")).get(key));
      if (value instanceof Uint8Array) {
        return value;
      }
      if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
      }
      return undefined;
    },
    async put(key, value) {
      await idbRequest((await store("readwrite")).put(value, key));
    },
    async delete(key) {
      await idbRequest((await store("readwrite")).delete(key));
    },
    async clear() {
      await idbRequest((await store("readwrite")).clear());
    },
  };
}

interface CacheStorageLike {
  open(name: string): Promise<{
    match(request: unknown): Promise<
      { arrayBuffer(): Promise<ArrayBuffer> } | undefined
    >;
    put(request: unknown, response: unknown): Promise<void>;
    delete(request: unknown): Promise<boolean>;
    keys?(): Promise<unknown[]>;
  }>;
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

const FALLBACK_CACHE_ORIGIN = "https://forge3d.invalid";

export function cacheStorageByteStore(namespace: string): PersistentByteStore {
  const requestUrl = (key: string) => {
    const location = (
      globalThis as typeof globalThis & { location?: { origin?: string } }
    ).location;
    const origin =
      typeof location?.origin === "string" && location.origin.length > 0
        ? location.origin
        : FALLBACK_CACHE_ORIGIN;
    return `${origin}/.forge3d/bytes/${namespace}/${encodeURIComponent(key)}`;
  };
  return {
    async get(key) {
      const caches = cacheStorageApi();
      if (caches === undefined) {
        return undefined;
      }
      const cache = await caches.open(namespace);
      const response = await cache.match(requestUrl(key));
      if (response === undefined || response === null) {
        return undefined;
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async put(key, value) {
      const caches = cacheStorageApi();
      const ResponseCtor = (
        globalThis as typeof globalThis & {
          Response?: new (
            body: Uint8Array,
            init?: { headers?: Record<string, string> },
          ) => unknown;
        }
      ).Response;
      if (caches === undefined || ResponseCtor === undefined) {
        return;
      }
      const cache = await caches.open(namespace);
      await cache.put(
        requestUrl(key),
        new ResponseCtor(value.slice(), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    },
    async delete(key) {
      const caches = cacheStorageApi();
      if (caches === undefined) {
        return;
      }
      const cache = await caches.open(namespace);
      await cache.delete(requestUrl(key));
    },
    async clear() {
      const caches = cacheStorageApi();
      if (caches === undefined) {
        return;
      }
      const cache = await caches.open(namespace);
      const keys = (await cache.keys?.()) ?? [];
      for (const request of keys) {
        await cache.delete(request);
      }
    },
  };
}

export interface PersistentByteCacheAdapterOptions {
  /** Namespace used by the real backend (directory name, DB name, cache). */
  name?: string;
  /** Injectable store; when omitted the real browser backend is used. */
  store?: PersistentByteStore;
}

/** OPFS-backed persistent adapter (`file://`-style namespace directory). */
export class OpfsByteCache extends DigestCheckedByteCache {
  constructor(options: PersistentByteCacheAdapterOptions = {}) {
    super("opfs", options.store ?? opfsByteStore(options.name ?? "forge3d-bytes"));
  }
}

/** IndexedDB-backed persistent adapter. */
export class IndexedDbByteCache extends DigestCheckedByteCache {
  constructor(options: PersistentByteCacheAdapterOptions = {}) {
    super(
      "indexeddb",
      options.store ?? indexedDbByteStore(options.name ?? "forge3d-bytes"),
    );
  }
}

/** CacheStorage-backed persistent adapter. */
export class CacheStorageByteCache extends DigestCheckedByteCache {
  constructor(options: PersistentByteCacheAdapterOptions = {}) {
    super(
      "cache-storage",
      options.store ?? cacheStorageByteStore(options.name ?? "forge3d-bytes"),
    );
  }
}

export type PersistentByteCacheKind = "opfs" | "indexeddb" | "cache-storage";

export interface CreatePersistentByteCacheOptions {
  name: string;
  prefer?: readonly PersistentByteCacheKind[];
  /** Test hook: injected stores per adapter kind. */
  stores?: Partial<Record<PersistentByteCacheKind, PersistentByteStore>>;
}

const ADAPTER_FACTORIES: Record<
  PersistentByteCacheKind,
  (options: PersistentByteCacheAdapterOptions) => PersistentByteCache
> = {
  opfs: (options) => new OpfsByteCache(options),
  indexeddb: (options) => new IndexedDbByteCache(options),
  "cache-storage": (options) => new CacheStorageByteCache(options),
};

/**
 * Create the first working persistent adapter in `prefer` order. A probe
 * write/read/delete round-trip must succeed; `null` when no backend works.
 */
export async function createPersistentByteCache(
  options: CreatePersistentByteCacheOptions,
): Promise<PersistentByteCache | null> {
  const prefer = options.prefer ?? ["opfs", "indexeddb", "cache-storage"];
  for (const kind of prefer) {
    const store = options.stores?.[kind];
    let adapter: PersistentByteCache;
    try {
      adapter = ADAPTER_FACTORIES[kind]({
        name: `${options.name}-${kind}`,
        ...(store !== undefined ? { store } : {}),
      });
      const probeKey = `forge3d:probe:${kind}`;
      const probe = new Uint8Array([1, 2, 3]);
      await adapter.put(probeKey, probe);
      const roundtrip = await adapter.get(probeKey);
      await adapter.delete(probeKey);
      if (
        roundtrip === undefined ||
        roundtrip.length !== probe.length ||
        roundtrip[0] !== 1 ||
        roundtrip[2] !== 3
      ) {
        continue;
      }
      return adapter;
    } catch {
      continue;
    }
  }
  return null;
}
