import { Forge3DError } from "./index.js";
import { serveForge3DMessagePort } from "./message-protocol.js";
import { ProjKernel, type ProjModule } from "./proj-kernel.js";

interface Request {
  kind: "init" | "metadata" | "transform" | "pipeline";
  moduleUrl?: string;
  moduleSource?: Uint8Array;
  wasm?: Uint8Array;
  database?: Uint8Array;
  grids?: Record<string, Uint8Array>;
  definition?: string;
  coords?: Float64Array;
  source?: string;
  target?: string;
  stride?: number;
  alwaysXY?: boolean;
  pipeline?: string;
}
let kernel: ProjKernel | undefined;
const scope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<{ port: MessagePort }>) => void,
  ): void;
};
scope.addEventListener("message", (event) => {
  if (!event.data.port) return;
  serveForge3DMessagePort(event.data.port, {
    async run(payload) {
      const req = payload as Request;
      if (req.kind === "init") {
        const factory = (await import(/* @vite-ignore */ req.moduleUrl!))
          .default as (options: {
          wasmBinary: Uint8Array;
          printErr: (line: string) => void;
        }) => Promise<ProjModule>;
        // Emscripten's pinned ESM has exactly one declaration and one export.
        // Compare the function the worker actually loaded with the verified
        // bytes before invoking it; a second HTTP response may differ.
        const expected = new TextDecoder("utf-8", { fatal: true }).decode(req.moduleSource!);
        const actual = Function.prototype.toString.call(factory) + "export default PROJModule;\n";
        if (actual !== expected)
          throw new Forge3DError("IO_ERROR", "Loaded PROJ factory differs from verified module", { kind: "asset-integrity", asset: "proj-emscripten.js" });
        const module = await factory({
          wasmBinary: req.wasm!,
          printErr: () => {},
        });
        kernel = new ProjKernel(module, req.database!, req.grids!);
        // Parse through the database before admitting the worker as ready.
        kernel.metadata("EPSG:4326");
        return { result: null, heapBytes: module.HEAPU8.byteLength };
      }
      if (!kernel)
        throw new Forge3DError(
          "WASM_LOAD_FAILED",
          "PROJ worker is not initialized",
        );
      const result =
        req.kind === "metadata"
          ? kernel.metadata(req.definition!)
          : kernel.transform(
              req.coords!,
              req.source!,
              req.target!,
              req.alwaysXY ?? true,
              req.stride ?? 2,
              req.pipeline,
            );
      return { result, heapBytes: kernel.module.HEAPU8.byteLength };
    },
  });
});
