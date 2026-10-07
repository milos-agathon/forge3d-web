import { Forge3DError } from "./index.js";
import type { Forge3DMessageHandler } from "./index.js";
import type { MeshInput, MeshBuffers } from "./mesh.js";
import {
  subdivideMesh,
  simplifyMesh,
  displaceProcedural,
  weldMesh,
} from "./mesh-processing.js";
export type MeshWorkerRequest =
  | { kind: "subdivide"; mesh: MeshInput; levels: number }
  | { kind: "simplify"; mesh: MeshInput; ratio: number }
  | { kind: "weld"; mesh: MeshInput; positionEpsilon: number }
  | { kind: "displace"; mesh: MeshInput; amplitude: number; frequency: number };
/** Register in W02 WorkerPool; transferMesh supplies dedicated transferable buffers. */
export function createMeshWorkerHandler(): Forge3DMessageHandler {
  return (payload, context) => {
    const request = payload as MeshWorkerRequest;
    if (context.signal.aborted)
      throw new Forge3DError("REQUEST_CANCELLED", "mesh operation cancelled");
    let result: MeshBuffers;
    switch (request.kind) {
      case "subdivide":
        result = subdivideMesh(request.mesh, { levels: request.levels });
        break;
      case "simplify":
        result = simplifyMesh(request.mesh, request.ratio);
        break;
      case "weld":
        result = weldMesh(request.mesh, {
          positionEpsilon: request.positionEpsilon,
        }).mesh;
        break;
      case "displace":
        result = displaceProcedural(
          request.mesh,
          request.amplitude,
          request.frequency,
        );
        break;
      default:
        throw new Forge3DError(
          "INVALID_INPUT",
          "unknown mesh worker operation",
        );
    }
    return result;
  };
}
