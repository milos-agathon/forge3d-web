import type {
  ProbeBakeWorkerRequest,
  ProbeBakeWorkerResult,
} from "./probe-bake-worker-client.js";

interface ProbeWasmModule {
  default?: (input?: { module_or_path?: Response | URL | string }) => Promise<unknown>;
  bakeTerrainProbeGrids?(input: unknown): {
    coefficients: number[];
    reflectionMips: number[][];
  };
}

interface WorkerErrorLike {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

const scope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ProbeBakeWorkerRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.addEventListener("message", (event) => {
  void bake(event.data).then(
    (result) => {
      const transfer: Transferable[] = [result.coefficients.buffer];
      for (const mip of result.reflectionMips) transfer.push(mip.buffer);
      scope.postMessage({ ok: true, ...result }, transfer);
    },
    (error: WorkerErrorLike) => {
      const reply: {
        ok: false;
        error: { code: string; message: string; details?: unknown };
      } = {
        ok: false,
        error: {
          code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
          message:
            typeof error?.message === "string"
              ? error.message
              : String(error),
        },
      };
      if (error?.details !== undefined) reply.error.details = error.details;
      scope.postMessage(reply);
    },
  );
});

async function bake(
  request: ProbeBakeWorkerRequest,
): Promise<ProbeBakeWorkerResult> {
  const [module, response] = await Promise.all([
    import(/* @vite-ignore */ request.wasmModuleUrl) as Promise<ProbeWasmModule>,
    fetch(request.wasmUrl),
  ]);
  if (!response.ok) {
    throw new Error(`probe worker WASM request failed with HTTP ${response.status}`);
  }
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/wasm") {
    throw new Error("probe worker WASM must be served as application/wasm");
  }
  await module.default?.({ module_or_path: response });
  if (module.bakeTerrainProbeGrids === undefined) {
    throw new Error("WASM bridge does not export the W09 grid probe baker");
  }
  const raw = module.bakeTerrainProbeGrids({
    heights: request.heights,
    width: request.width,
    height: request.height,
    terrainWidth: request.terrainWidth,
    terrainOrigin: request.terrainOrigin,
    irradiancePositions: request.irradiancePositions,
    reflectionPositions: request.reflectionPositions,
    skyColor: request.skyColor,
    skyIntensity: request.skyIntensity,
    rayCount: request.rayCount,
    maxTraceDistance: request.maxTraceDistance,
    reflectionResolution: request.reflectionResolution,
    reflectionSamples: request.reflectionSamples,
    terrainColor: request.terrainColor,
    reflectionMaterial: request.reflectionMaterial,
    reflectionLighting: request.reflectionLighting,
  });
  return {
    coefficients: Float32Array.from(raw.coefficients),
    reflectionMips: raw.reflectionMips.map((mip) => Float32Array.from(mip)),
  };
}
