import {
  Forge3DError,
  type PersistentByteCache,
  type ByteReadProgress,
} from "./index.js";
import { readByteSource } from "./browser-io.js";
import { MemoryByteCache } from "./byte-cache.js";

export interface VerifiedAsset {
  name: string;
  url: string | URL;
  sha256: string;
  byteLength?: number;
  version: string;
}
export interface AssetReadOptions {
  signal?: AbortSignal;
  offline?: boolean;
  onProgress?: (progress: ByteReadProgress) => void;
}
export async function assetDigest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "Asset integrity requires WebCrypto SHA-256",
    );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function assetAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "Asset operation cancelled");
}
/** Abort storage/crypto waits too, including an unresponsive injected cache. */
async function assetWait<T>(
  promise: Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  assetAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        new Forge3DError("REQUEST_CANCELLED", "Asset operation cancelled"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** Content-addressed cache. Expected digests are checked even on cache hits. */
export class VerifiedAssetStore {
  readonly memory: MemoryByteCache;
  #disposed = false;
  #active = new Set<AbortController>();
  constructor(
    readonly persistent: PersistentByteCache | null,
    readonly maxAssetBytes: number,
    memoryBytes: number,
  ) {
    if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1)
      throw new Forge3DError(
        "INVALID_INPUT",
        "maxAssetBytes must be a positive safe integer",
      );
    this.memory = new MemoryByteCache(memoryBytes);
  }
  async read(
    asset: VerifiedAsset,
    options: AssetReadOptions = {},
  ): Promise<Uint8Array> {
    this.guard();
    assetAbort(options.signal);
    if (!/^[a-f0-9]{64}$/i.test(asset.sha256) || !asset.version || !asset.name)
      throw new Forge3DError(
        "INVALID_INPUT",
        "Asset needs a name, version and SHA-256 digest",
      );
    if (
      asset.byteLength !== undefined &&
      (!Number.isSafeInteger(asset.byteLength) ||
        asset.byteLength < 1 ||
        asset.byteLength > this.maxAssetBytes)
    )
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Asset exceeds byte limit",
        { asset: asset.name },
      );
    const key = `forge3d:asset:${asset.version}:${asset.sha256.toLowerCase()}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.#active.add(controller);
    const check = () => {
      this.guard();
      assetAbort(controller.signal);
    };
    try {
      let bytes =
        this.memory.get(key) ??
        (await assetWait(this.persistent?.get(key), controller.signal));
      check();
      if (bytes !== undefined) {
        if (await assetWait(this.valid(asset, bytes), controller.signal)) {
          check();
          this.memory.put(key, bytes);
          return bytes.slice();
        }
        this.memory.delete(key);
        await assetWait(this.persistent?.delete(key), controller.signal);
        check();
        if (options.offline)
          throw new Forge3DError("IO_ERROR", "Cached asset digest mismatch", {
            kind: "asset-integrity",
            asset: asset.name,
          });
      }
      if (options.offline)
        throw new Forge3DError(
          "IO_ERROR",
          "Asset is unavailable in offline cache",
          { kind: "offline-cache-miss", asset: asset.name },
        );
      bytes = await readByteSource(asset.url, {
        maxBytes: this.maxAssetBytes,
        signal: controller.signal,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
      check();
      if (!(await assetWait(this.valid(asset, bytes), controller.signal)))
        throw new Forge3DError(
          "IO_ERROR",
          "Downloaded asset digest or size mismatch",
          {
            kind: "asset-integrity",
            asset: asset.name,
            expectedSha256: asset.sha256,
          },
        );
      check();
      await assetWait(this.persistent?.put(key, bytes), controller.signal);
      check();
      this.memory.put(key, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof Forge3DError) throw error;
      assetAbort(controller.signal);
      throw new Forge3DError("IO_ERROR", "Asset storage or verification failed", {
        kind: "asset-io",
        asset: asset.name,
        reason: String(error),
      });
    } finally {
      this.#active.delete(controller);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  private async valid(
    asset: VerifiedAsset,
    bytes: Uint8Array,
  ): Promise<boolean> {
    return (
      bytes.byteLength <= this.maxAssetBytes &&
      (asset.byteLength === undefined ||
        asset.byteLength === bytes.byteLength) &&
      (await assetDigest(bytes)) === asset.sha256.toLowerCase()
    );
  }
  guard(): void {
    if (this.#disposed)
      throw new Forge3DError("RUNTIME_DISPOSED", "Asset store is disposed");
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const c of this.#active) c.abort();
    this.#active.clear();
    this.memory.clear();
  }
}
