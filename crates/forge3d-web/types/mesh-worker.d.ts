import type { Forge3DMessageHandler } from "./index.js";
import type { MeshInput } from "./mesh.js";
export type MeshWorkerRequest = {
    kind: "subdivide";
    mesh: MeshInput;
    levels: number;
} | {
    kind: "simplify";
    mesh: MeshInput;
    ratio: number;
} | {
    kind: "weld";
    mesh: MeshInput;
    positionEpsilon: number;
} | {
    kind: "displace";
    mesh: MeshInput;
    amplitude: number;
    frequency: number;
};
/** Register in W02 WorkerPool; transferMesh supplies dedicated transferable buffers. */
export declare function createMeshWorkerHandler(): Forge3DMessageHandler;
