import type { BrowserByteSource, ByteReadOptions } from "./index.js";
import type { MeshBuffers, MeshInput } from "./mesh.js";
export interface GltfLoadOptions extends ByteReadOptions {
    baseUrl?: string | URL;
    /** Return external bytes without a filesystem. Paths resolve against baseUrl. */
    resolveUri?: (uri: string, signal?: AbortSignal) => Promise<Uint8Array>;
}
export interface GltfPrimitive {
    mesh: MeshBuffers;
    meshIndex: number;
    primitiveIndex: number;
    material: number | null;
    name: string;
}
export interface GltfAsset {
    primitives: GltfPrimitive[];
    materials: Readonly<Record<string, unknown>>[];
    nodes: Readonly<Record<string, unknown>>[];
    scenes: Readonly<Record<string, unknown>>[];
    defaultScene: number | null;
}
/** Internal shared adapter: settle cancellation even if an application resolver ignores it. */
export declare function resolveMeshUri(resolver: NonNullable<GltfLoadOptions["resolveUri"]>, uri: string, signal?: AbortSignal): Promise<Uint8Array>;
export declare function decodeGltf(bytes: Uint8Array, o?: GltfLoadOptions): Promise<GltfAsset>;
export declare function loadGltf(source: BrowserByteSource, o?: GltfLoadOptions): Promise<GltfAsset>;
/** Binary glTF preserves f32 attributes and u32 indices exactly. */
export declare function encodeGlb(input: MeshInput): Uint8Array;
