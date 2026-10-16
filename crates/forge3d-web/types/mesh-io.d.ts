import type { BrowserByteSource, BrowserByteSink, ByteReadOptions, ByteWriteResult } from "./index.js";
import type { ObjImport } from "./mesh-obj.js";
import type { GltfLoadOptions } from "./mesh-gltf.js";
import type { MeshBuffers, MeshInput } from "./mesh.js";
export type MeshFormat = "obj" | "stl" | "gltf" | "glb";
export interface MeshLoadOptions extends GltfLoadOptions {
    format: MeshFormat;
}
export declare function loadObj(source: BrowserByteSource, o?: GltfLoadOptions): Promise<ObjImport>;
export declare function loadMesh(source: BrowserByteSource, o: MeshLoadOptions): Promise<MeshBuffers>;
export interface MeshExportOptions {
    binaryStl?: boolean;
    signal?: AbortSignal;
    objMetadata?: Pick<ObjImport, "groups" | "objects" | "materialGroups" | "materialLibraries">;
}
export declare function exportMesh(mesh: MeshInput, format: "obj" | "stl" | "glb", o?: MeshExportOptions): Blob;
export declare function exportMeshToSink(mesh: MeshInput, format: "obj" | "stl" | "glb", sink: BrowserByteSink, o?: MeshExportOptions): Promise<ByteWriteResult>;
/** Pending reads are cancelled at disposal; each load has its own bounded storage. */
export declare class MeshIo {
    #private;
    get disposed(): boolean;
    get pendingReads(): number;
    load(source: BrowserByteSource, o: MeshLoadOptions): Promise<MeshBuffers>;
    dispose(): void;
}
export type MeshIoOptions = ByteReadOptions;
