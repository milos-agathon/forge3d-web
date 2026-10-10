import { serveForge3DMessagePort } from "./message-protocol.js";
import { decodeLazLocal, decodeLazChunkLocal } from "./laz-decoder-local.js";
import { pointError } from "./pointcloud-common.js";
import type { PointCloudWorkerRequest } from "./pointcloud.js";

const scope = globalThis as unknown as {
  addEventListener(type: "message", fn: (event: MessageEvent<{ port: MessagePort }>) => void): void;
};
scope.addEventListener("message", (event) => {
  if (event.data.port) serveForge3DMessagePort(event.data.port, {
    run: (payload, context) => {
      const request = payload as PointCloudWorkerRequest;
      if (!request || !(request.bytes instanceof Uint8Array)) pointError("Invalid LAZ request");
      const options = { signal: context.signal,
        ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}) };
      if (request.kind === "laz-file") return decodeLazLocal(request.bytes, options);
      if (request.kind === "laz-chunk")
        return decodeLazChunkLocal(request.bytes, request.header, request.count, options);
      return pointError("Unknown LAZ request");
    },
  });
});
