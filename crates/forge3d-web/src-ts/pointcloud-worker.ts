import { serveForge3DMessagePort } from "./message-protocol.js";
import { createPointCloudWorkerHandler } from "./pointcloud.js";
const scope = globalThis as unknown as {
  addEventListener(
    type: "message",
    fn: (event: MessageEvent<{ port: MessagePort }>) => void,
  ): void;
};
scope.addEventListener("message", (event) => {
  if (event.data.port)
    serveForge3DMessagePort(event.data.port, {
      run: createPointCloudWorkerHandler(),
    });
});
