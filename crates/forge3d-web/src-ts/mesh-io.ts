import { readByteSource, writeByteSink } from "./browser-io.js";
import { Forge3DError } from "./index.js";
import type {
  BrowserByteSource,
  BrowserByteSink,
  ByteReadOptions,
  ByteWriteResult,
} from "./index.js";
import { parseObj, encodeObj, parseMtl } from "./mesh-obj.js";
import type { ObjImport } from "./mesh-obj.js";
import { parseStl, encodeStl } from "./mesh-stl.js";
import { decodeGltf, encodeGlb, resolveMeshUri } from "./mesh-gltf.js";
import type { GltfLoadOptions } from "./mesh-gltf.js";
import type { MeshBuffers, MeshInput } from "./mesh.js";
import { MAX_MESH_BYTES, meshError, meshLimit } from "./mesh.js";
export type MeshFormat = "obj" | "stl" | "gltf" | "glb";
export interface MeshLoadOptions extends GltfLoadOptions {
  format: MeshFormat;
}
export async function loadObj(
  source: BrowserByteSource,
  o: GltfLoadOptions = {},
): Promise<ObjImport> {
  const bytes = await readByteSource(source, {
      maxBytes: MAX_MESH_BYTES,
      ...o,
    }),
    text = new TextDecoder().decode(bytes),
    result = parseObj(text);
  let used = bytes.length;
  const base =
    o.baseUrl ??
    (typeof source === "string" || source instanceof URL
      ? String(source)
      : undefined);
  for (const uri of result.materialLibraries) {
    if (o.signal?.aborted)
      throw new Forge3DError("REQUEST_CANCELLED", "OBJ load cancelled");
    if (!base && !o.resolveUri) continue;
    let path = uri;
    try {
      if (base) path = new URL(uri, base).href;
    } catch {
      meshError("invalid material library URL");
    }
    const data = o.resolveUri
      ? await resolveMeshUri(o.resolveUri, path, o.signal)
      : await readByteSource(path, {
          ...o,
          maxBytes: (o.maxBytes ?? MAX_MESH_BYTES) - used,
        });
    used += data.length;
    meshLimit(used, o.maxBytes);
    result.materials.push(...parseMtl(new TextDecoder().decode(data)));
  }
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "OBJ load cancelled");
  return result;
}
export async function loadMesh(
  source: BrowserByteSource,
  o: MeshLoadOptions,
): Promise<MeshBuffers> {
  if (o.format === "obj") return (await loadObj(source, o)).mesh;
  const bytes = await readByteSource(source, {
    maxBytes: MAX_MESH_BYTES,
    ...o,
  });
  if (o.format === "stl") return parseStl(bytes);
  if (o.format === "gltf" || o.format === "glb") {
    const opts = { ...o };
    if (!opts.baseUrl && (typeof source === "string" || source instanceof URL))
      opts.baseUrl = String(source);
    return (await decodeGltf(bytes, opts)).primitives[0]!.mesh;
  }
  meshError("unknown mesh format");
}
export interface MeshExportOptions {
  binaryStl?: boolean;
  signal?: AbortSignal;
  objMetadata?: Pick<
    ObjImport,
    "groups" | "objects" | "materialGroups" | "materialLibraries"
  >;
}
export function exportMesh(
  mesh: MeshInput,
  format: "obj" | "stl" | "glb",
  o: MeshExportOptions = {},
): Blob {
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "mesh export cancelled");
  let bytes: Uint8Array, type: string;
  if (format === "obj") {
    bytes = new TextEncoder().encode(encodeObj(mesh, o.objMetadata));
    type = "text/plain";
  } else if (format === "stl") {
    bytes = encodeStl(mesh, o.binaryStl ?? true);
    type = "model/stl";
  } else if (format === "glb") {
    bytes = encodeGlb(mesh);
    type = "model/gltf-binary";
  } else meshError("unknown mesh export format");
  return new Blob([bytes as BlobPart], { type });
}
export async function exportMeshToSink(
  mesh: MeshInput,
  format: "obj" | "stl" | "glb",
  sink: BrowserByteSink,
  o: MeshExportOptions = {},
): Promise<ByteWriteResult> {
  const blob = exportMesh(mesh, format, o);
  const bytes = await blob.arrayBuffer();
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "mesh export cancelled");
  return writeByteSink(bytes, sink);
}
/** Pending reads are cancelled at disposal; each load has its own bounded storage. */
export class MeshIo {
  #pending = new Set<AbortController>();
  #disposed = false;
  get disposed(): boolean {
    return this.#disposed;
  }
  get pendingReads(): number {
    return this.#pending.size;
  }
  async load(
    source: BrowserByteSource,
    o: MeshLoadOptions,
  ): Promise<MeshBuffers> {
    if (this.#disposed)
      throw new Forge3DError("RUNTIME_DISPOSED", "Mesh IO disposed");
    const controller = new AbortController(),
      abort = () => controller.abort();
    this.#pending.add(controller);
    o.signal?.addEventListener("abort", abort, { once: true });
    if (o.signal?.aborted) abort();
    try {
      return await loadMesh(source, { ...o, signal: controller.signal });
    } finally {
      o.signal?.removeEventListener("abort", abort);
      this.#pending.delete(controller);
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const c of this.#pending) c.abort();
    this.#pending.clear();
  }
}
export type MeshIoOptions = ByteReadOptions;
