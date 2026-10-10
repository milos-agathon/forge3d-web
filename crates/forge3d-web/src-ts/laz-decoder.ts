import { Forge3DError } from "./index.js";
import { Forge3DWorkerPool } from "./browser-resources.js";
import { parseLasHeader, parseLasRecords } from "./pointcloud-las.js";
import { pointCancelled, pointError } from "./pointcloud-common.js";
import { validateLazDecode } from "./laz-decoder-local.js";
import type { LasHeader } from "./pointcloud-las.js";
import type { PointData } from "./pointcloud-types.js";

export interface LazDecodeOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  /** Enqueue-to-completion deadline, including worker/module startup; default 30 s. */
  timeoutMs?: number;
}

/** Never execute untrusted synchronous native decode on the caller's thread. */
async function decodeOwned(
  bytes: Uint8Array, header: LasHeader, count: number, chunk: boolean,
  options: LazDecodeOptions,
): Promise<PointData> {
  validateLazDecode(bytes, header, count, chunk, options);
  if (typeof Worker !== "function" || typeof MessageChannel !== "function")
    throw new Forge3DError("UNSUPPORTED_FEATURE", "LAZ decoding requires owned workers",
      { reason: "worker-hard-stop-unavailable" });
  const source = new URL(import.meta.url).pathname.includes("/src-ts/");
  let pool: Forge3DWorkerPool | undefined;
  try {
    pool = new Forge3DWorkerPool({
      size: 1,
      workerFactory: () => {
        const worker = new Worker(
          new URL(source ? "./laz-worker.ts" : "./laz-worker.js", import.meta.url),
          { type: "module", name: "forge3d-laz" },
        );
        const channel = new MessageChannel();
        try { worker.postMessage({ port: channel.port2 }, [channel.port2]); }
        catch (error) {
          worker.terminate(); channel.port1.close(); channel.port2.close();
          throw error;
        }
        return { port: channel.port1, terminate: () => worker.terminate() };
      },
      mainThreadHandler: () => {
        throw new Forge3DError("UNSUPPORTED_FEATURE", "LAZ decoding requires a worker");
      },
    });
    return await pool.run<PointData>(
      { bytes, header, count, kind: chunk ? "laz-chunk" : "laz-file",
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) },
      { requireHardStop: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
    );
  } catch (error) {
    if (error instanceof Forge3DError) throw error;
    throw new Forge3DError("WASM_LOAD_FAILED", "LAZ worker could not be created",
      { reason: "laz-worker-unavailable", message: String(error) });
  } finally {
    pool?.dispose();
  }
}

export async function decodeLaz(
  bytes: Uint8Array, options: LazDecodeOptions = {},
): Promise<PointData> {
  pointCancelled(options.signal);
  const header = parseLasHeader(bytes);
  if (header.pointOffset > bytes.length) pointError("Truncated LAS/LAZ file");
  if (!header.compressed)
    return parseLasRecords(bytes.subarray(header.pointOffset,
      header.pointOffset + header.pointCount * header.recordLength),
      header.pointCount, header, options);
  return decodeOwned(bytes, header, header.pointCount, false, options);
}

export async function decodeLazChunk(
  bytes: Uint8Array, header: LasHeader, count: number,
  options: LazDecodeOptions = {},
): Promise<PointData> {
  if (!header.compressed) pointError("COPC requires compressed LAS records");
  if (![6, 7, 8].includes(header.pointFormat))
    pointError("COPC requires LAS point format 6/7/8", "invalid-copc");
  return decodeOwned(bytes, header, count, true, options);
}
