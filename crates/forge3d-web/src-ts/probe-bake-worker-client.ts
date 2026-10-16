import { Forge3DError, type Forge3DErrorCode } from "./index.js";
import type { ProbeReflectionMaterial } from "./probe-bake-options.js";
import { loadProbeWorkerWasmAssets } from "./runtime-internals.js";

export interface ProbeBakeWorkerLighting {
  lightDirection: number[];
  lightColor: number[];
  lightIntensity: number;
  environment: null | { width: number; height: number; data: Float32Array };
  environmentIntensity: number;
  environmentRotationRad: number;
}

export interface ProbeBakeWorkerRequest {
  wasmModuleUrl: string;
  wasmUrl: string;
  heights: Float32Array;
  width: number;
  height: number;
  terrainWidth: number;
  terrainOrigin: readonly [number, number];
  irradiancePositions: Float32Array;
  reflectionPositions: Float32Array;
  skyColor: readonly [number, number, number];
  skyIntensity: number;
  rayCount: number;
  maxTraceDistance: number;
  reflectionResolution: number;
  reflectionSamples: number;
  terrainColor: readonly [number, number, number];
  reflectionMaterial: ProbeReflectionMaterial;
  reflectionLighting: ProbeBakeWorkerLighting;
}

export interface ProbeBakeWorkerResult {
  coefficients: Float32Array;
  reflectionMips: Float32Array[];
}

interface WorkerSuccess {
  ok: true;
  coefficients: Float32Array;
  reflectionMips: Float32Array[];
}

interface WorkerFailure {
  ok: false;
  error: { code: Forge3DErrorCode; message: string; details?: unknown };
}

type WorkerReply = WorkerSuccess | WorkerFailure;

export function probeWorkerAssetUrls(): {
  worker: URL;
} {
  const sourceModule = new URL(import.meta.url).pathname.includes("/src-ts/");
  return {
    worker: new URL(
      sourceModule ? "./probe-bake-worker.ts" : "./probe-bake-worker.js",
      import.meta.url,
    ),
  };
}

export async function bakeProbeGridsInWorker(
  input: Omit<ProbeBakeWorkerRequest, "wasmModuleUrl" | "wasmUrl">,
  signal?: AbortSignal,
): Promise<ProbeBakeWorkerResult> {
  if (signal?.aborted) {
    return Promise.reject(
      new Forge3DError("REQUEST_CANCELLED", "probe bake cancelled"),
    );
  }
  if (typeof Worker === "undefined") {
    return Promise.reject(
      new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "probe baking requires a module Worker",
      ),
    );
  }
  const urls = probeWorkerAssetUrls();
  const wasm = await loadProbeWorkerWasmAssets();
  if (signal?.aborted) {
    throw new Forge3DError("REQUEST_CANCELLED", "probe bake cancelled");
  }
  let worker: Worker;
  try {
    worker = new Worker(urls.worker, {
      type: "module",
      name: "forge3d-probe-baker",
    });
  } catch (error) {
    return Promise.reject(
      new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "probe bake worker could not be created",
        error,
      ),
    );
  }

  return new Promise<ProbeBakeWorkerResult>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
      action();
    };
    const onAbort = (): void =>
      finish(() =>
        reject(new Forge3DError("REQUEST_CANCELLED", "probe bake cancelled")),
      );
    const onMessage = (event: MessageEvent<WorkerReply>): void => {
      const reply = event.data;
      if (typeof reply !== "object" || reply === null || !("ok" in reply)) {
        finish(() =>
          reject(
            new Forge3DError("INTERNAL_ERROR", "invalid probe worker reply"),
          ),
        );
        return;
      }
      if (!reply.ok) {
        finish(() =>
          reject(
            new Forge3DError(
              reply.error.code,
              reply.error.message,
              reply.error.details,
            ),
          ),
        );
        return;
      }
      finish(() =>
        resolve({
          coefficients: reply.coefficients,
          reflectionMips: reply.reflectionMips,
        }),
      );
    };
    const onError = (event: ErrorEvent): void =>
      finish(() =>
        reject(
          new Forge3DError(
            "INTERNAL_ERROR",
            event.message || "probe bake worker failed",
          ),
        ),
      );

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    const request: ProbeBakeWorkerRequest = {
      ...input,
      wasmModuleUrl: wasm.wasmModuleUrl,
      wasmUrl: wasm.wasmUrl,
    };
    const transfer: Transferable[] = [
      input.heights.buffer,
      input.irradiancePositions.buffer,
      input.reflectionPositions.buffer,
    ];
    const environment = input.reflectionLighting.environment;
    if (environment !== null) transfer.push(environment.data.buffer);
    try {
      worker.postMessage(request, transfer);
    } catch (error) {
      finish(() => reject(Forge3DError.from(error)));
    }
  });
}
