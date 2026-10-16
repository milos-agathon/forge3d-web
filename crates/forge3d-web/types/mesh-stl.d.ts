import type { MeshInput, MeshBuffers } from "./mesh.js";
export declare function encodeStl(m: MeshInput, binary?: boolean): Uint8Array;
export declare function parseStl(data: Uint8Array): MeshBuffers;
