import { Forge3DError } from "./index.js";
import { readByteSource } from "./browser-io.js";
import type { BrowserByteSource, ByteReadOptions } from "./index.js";
import {
  checkMesh,
  meshError,
  meshLimit,
  meshInteger,
  MAX_MESH_BYTES,
  cloneMesh,
  meshBounds,
} from "./mesh.js";
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
type RecordValue = Record<string, unknown>;
/** Internal shared adapter: settle cancellation even if an application resolver ignores it. */
export async function resolveMeshUri(
  resolver: NonNullable<GltfLoadOptions["resolveUri"]>,
  uri: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "mesh resource load cancelled");
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new Forge3DError("REQUEST_CANCELLED", "mesh resource load cancelled"),
      );
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const bytes = await Promise.race([resolver(uri, signal), cancelled]);
    if (!(bytes instanceof Uint8Array))
      meshError("resource resolver must return Uint8Array");
    return bytes;
  } catch (error) {
    if (error instanceof Forge3DError) throw error;
    throw new Forge3DError("IO_ERROR", "mesh resource resolver failed");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
function record(v: unknown, name: string): RecordValue {
  if (!v || typeof v !== "object" || Array.isArray(v))
    meshError(`${name} must be an object`);
  return v as RecordValue;
}
function list(v: unknown, name: string): RecordValue[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) meshError(`${name} must be an array`);
  return v.map((x) => record(x, name));
}
function integer(
  v: unknown,
  name: string,
  min = 0,
  max = MAX_MESH_BYTES,
): number {
  if (typeof v !== "number") meshError(`${name} must be an integer`);
  return meshInteger(v, name, min, max);
}
function dataUri(uri: string): Uint8Array {
  const match = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!match) meshError("invalid data URI");
  try {
    if (match[1]!.endsWith(";base64"))
      return Uint8Array.from(atob(match[2]!), (x) => x.charCodeAt(0));
    return new TextEncoder().encode(decodeURIComponent(match[2]!));
  } catch {
    meshError("invalid data URI payload");
  }
}
export async function decodeGltf(
  bytes: Uint8Array,
  o: GltfLoadOptions = {},
): Promise<GltfAsset> {
  const budget = o.maxBytes ?? MAX_MESH_BYTES;
  meshLimit(bytes.byteLength, budget);
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "glTF load cancelled");
  let doc: RecordValue, bin: Uint8Array | undefined;
  try {
    if (
      bytes.length >= 4 &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        0,
        true,
      ) === 0x46546c67
    ) {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (
        bytes.length < 20 ||
        v.getUint32(4, true) !== 2 ||
        v.getUint32(8, true) !== bytes.length
      )
        meshError("invalid GLB header");
      let cursor = 12,
        json: Uint8Array | undefined;
      while (cursor < bytes.length) {
        if (cursor + 8 > bytes.length) meshError("truncated GLB chunk");
        const n = v.getUint32(cursor, true),
          type = v.getUint32(cursor + 4, true);
        if (n % 4 || cursor + 8 + n > bytes.length)
          meshError("invalid GLB chunk length");
        const data = bytes.subarray(cursor + 8, cursor + 8 + n);
        if (cursor === 12 && type !== 0x4e4f534a)
          meshError("first GLB chunk must be JSON");
        if (type === 0x4e4f534a) {
          if (json) meshError("duplicate GLB JSON");
          json = data;
        } else if (type === 0x004e4942) {
          if (bin) meshError("duplicate GLB BIN");
          bin = data;
        }
        cursor += 8 + n;
      }
      if (!json) meshError("GLB JSON missing");
      doc = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)),
        "glTF",
      );
    } else
      doc = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        "glTF",
      );
  } catch (e) {
    if (e instanceof Forge3DError) throw e;
    meshError("malformed glTF JSON");
  }
  if (record(doc.asset, "asset").version !== "2.0")
    meshError("only glTF 2.0 is supported");
  if (doc.extensionsRequired !== undefined) {
    if (!Array.isArray(doc.extensionsRequired))
      meshError("invalid required extensions");
    if (doc.extensionsRequired.length)
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "plain glTF decoder does not support required extensions",
        { extensions: doc.extensionsRequired },
      );
  }
  const bufferDefs = list(doc.buffers, "buffers"),
    views = list(doc.bufferViews, "bufferViews"),
    accessors = list(doc.accessors, "accessors");
  const buffers: Uint8Array[] = [];
  let used = bytes.byteLength,
    allocated = 0;
  for (let i = 0; i < bufferDefs.length; i++) {
    const b = bufferDefs[i]!,
      length = integer(b.byteLength, "buffer.byteLength");
    let data: Uint8Array;
    if (b.uri === undefined) {
      if (i !== 0 || !bin) meshError("buffer URI or GLB BIN missing");
      data = bin;
    } else {
      if (typeof b.uri !== "string") meshError("buffer URI must be string");
      if (b.uri.startsWith("data:")) data = dataUri(b.uri);
      else {
        if (o.signal?.aborted)
          throw new Forge3DError("REQUEST_CANCELLED", "glTF load cancelled");
        let uri = b.uri;
        try {
          if (o.baseUrl) uri = new URL(b.uri, o.baseUrl).href;
        } catch {
          meshError("invalid external buffer URL");
        }
        if (o.resolveUri)
          data = await resolveMeshUri(o.resolveUri, uri, o.signal);
        else {
          if (!o.baseUrl)
            meshError("external buffers require baseUrl or resolveUri");
          data = await readByteSource(uri, { ...o, maxBytes: budget - used });
        }
      }
      used += data.byteLength;
      meshLimit(used, budget);
    }
    if (data.byteLength < length || data.byteLength > length + 3)
      meshError("buffer byteLength mismatch");
    buffers.push(data.subarray(0, length));
  }
  function readView(id: number): { data: Uint8Array; definition: RecordValue } {
    const definition = views[id];
    if (!definition) meshError("bufferView out of bounds");
    const b = buffers[integer(definition.buffer, "bufferView.buffer")];
    if (!b) meshError("bufferView buffer missing");
    const offset = integer(definition.byteOffset ?? 0, "bufferView.byteOffset"),
      length = integer(definition.byteLength, "bufferView.byteLength");
    if (offset + length > b.length)
      meshError("bufferView range exceeds buffer");
    return { data: b.subarray(offset, offset + length), definition };
  }
  const widths: Record<string, number> = {
      SCALAR: 1,
      VEC2: 2,
      VEC3: 3,
      VEC4: 4,
    },
    sizes: Record<number, number> = {
      5120: 1,
      5121: 1,
      5122: 2,
      5123: 2,
      5125: 4,
      5126: 4,
    };
  function scalar(
    v: DataView,
    off: number,
    type: number,
    normalized: boolean,
  ): number {
    let x: number;
    switch (type) {
      case 5120:
        x = v.getInt8(off);
        return normalized ? Math.max(x / 127, -1) : x;
      case 5121:
        x = v.getUint8(off);
        return normalized ? x / 255 : x;
      case 5122:
        x = v.getInt16(off, true);
        return normalized ? Math.max(x / 32767, -1) : x;
      case 5123:
        x = v.getUint16(off, true);
        return normalized ? x / 65535 : x;
      case 5125:
        return v.getUint32(off, true);
      case 5126:
        x = v.getFloat32(off, true);
        if (!Number.isFinite(x)) meshError("non-finite accessor");
        return x;
      default:
        meshError("unsupported componentType");
    }
  }
  function accessor(
    id: number,
    shape: string,
    indices = false,
  ): Float32Array | Uint32Array {
    const a = accessors[id];
    if (!a) meshError("accessor out of bounds");
    if (a.type !== shape) meshError(`accessor must be ${shape}`);
    const type = integer(a.componentType, "componentType"),
      size = sizes[type],
      width = widths[shape]!,
      count = integer(a.count, "accessor.count");
    if (!size) meshError("unsupported componentType");
    if (indices && ![5121, 5123, 5125].includes(type))
      meshError("indices must be unsigned integers");
    if (indices && a.normalized) meshError("indices cannot be normalized");
    const normalized = a.normalized === true;
    allocated += count * width * 4;
    meshLimit(used + allocated, budget);
    const out = indices
      ? new Uint32Array(count * width)
      : new Float32Array(count * width);
    if (a.bufferView !== undefined) {
      const { data, definition } = readView(
          integer(a.bufferView, "accessor.bufferView"),
        ),
        stride = integer(
          definition.byteStride ?? width * size,
          "byteStride",
          width * size,
          252,
        ),
        off = integer(a.byteOffset ?? 0, "accessor.byteOffset");
      if (
        off % size ||
        stride % size ||
        (count && off + (count - 1) * stride + width * size > data.length)
      )
        meshError("accessor exceeds view or has invalid alignment");
      const v = new DataView(data.buffer, data.byteOffset, data.length);
      for (let i = 0; i < count; i++)
        for (let j = 0; j < width; j++)
          out[i * width + j] = scalar(
            v,
            off + i * stride + j * size,
            type,
            normalized,
          );
    } else if (a.sparse === undefined) meshError("accessor has no data");
    if (a.sparse !== undefined) {
      const sparse = record(a.sparse, "sparse"),
        n = integer(sparse.count, "sparse.count", 1, count),
        ids = record(sparse.indices, "sparse.indices"),
        values = record(sparse.values, "sparse.values"),
        it = integer(ids.componentType, "sparse index type"),
        is = sizes[it];
      if (!is || ![5121, 5123, 5125].includes(it))
        meshError("invalid sparse indices");
      const iv = readView(integer(ids.bufferView, "sparse indices view")).data,
        vv = readView(integer(values.bufferView, "sparse values view")).data,
        io = integer(ids.byteOffset ?? 0, "sparse indices offset"),
        vo = integer(values.byteOffset ?? 0, "sparse values offset");
      if (io + n * is > iv.length || vo + n * width * size > vv.length)
        meshError("sparse accessor exceeds view");
      const idv = new DataView(iv.buffer, iv.byteOffset, iv.length),
        valv = new DataView(vv.buffer, vv.byteOffset, vv.length);
      let previous = -1;
      for (let k = 0; k < n; k++) {
        const i = scalar(idv, io + k * is, it, false);
        if (i <= previous || i >= count)
          meshError("sparse indices must increase within accessor");
        previous = i;
        for (let j = 0; j < width; j++)
          out[i * width + j] = scalar(
            valv,
            vo + (k * width + j) * size,
            type,
            normalized,
          );
      }
    }
    return out;
  }
  const primitives: GltfPrimitive[] = [];
  const meshes = list(doc.meshes, "meshes"),
    materials = list(doc.materials, "materials");
  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi]!;
    for (const [pi, p] of list(mesh.primitives, "primitives").entries()) {
      const ext =
        p.extensions === undefined
          ? {}
          : record(p.extensions, "primitive.extensions");
      if (ext.KHR_draco_mesh_compression)
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Draco is not supported by the plain glTF decoder",
        );
      if ((p.mode ?? 4) !== 4)
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "plain glTF decoder requires triangle primitives",
          { mode: p.mode },
        );
      const attrs = record(p.attributes, "attributes"),
        positions = accessor(
          integer(attrs.POSITION, "POSITION"),
          "VEC3",
        ) as Float32Array,
        nv = positions.length / 3;
      const m: MeshBuffers = {
        positions,
        normals:
          attrs.NORMAL === undefined
            ? new Float32Array()
            : (accessor(
                integer(attrs.NORMAL, "NORMAL"),
                "VEC3",
              ) as Float32Array),
        uvs:
          attrs.TEXCOORD_0 === undefined
            ? new Float32Array()
            : (accessor(
                integer(attrs.TEXCOORD_0, "TEXCOORD_0"),
                "VEC2",
              ) as Float32Array),
        tangents:
          attrs.TANGENT === undefined
            ? new Float32Array()
            : (accessor(
                integer(attrs.TANGENT, "TANGENT"),
                "VEC4",
              ) as Float32Array),
        indices:
          p.indices === undefined
            ? Uint32Array.from({ length: nv }, (_, i) => i)
            : (accessor(
                integer(p.indices, "indices"),
                "SCALAR",
                true,
              ) as Uint32Array),
      };
      checkMesh(m);
      if (!m.positions.length || !m.indices.length)
        meshError("glTF primitive is empty");
      const material =
        p.material === undefined
          ? null
          : integer(p.material, "material", 0, materials.length - 1);
      primitives.push({
        mesh: m,
        meshIndex: mi,
        primitiveIndex: pi,
        material,
        name: typeof mesh.name === "string" ? mesh.name : `mesh-${mi}`,
      });
    }
  }
  if (!primitives.length) meshError("glTF contains no mesh primitives");
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "glTF load cancelled");
  const nodes = list(doc.nodes, "nodes"),
    scenes = list(doc.scenes, "scenes");
  return {
    primitives,
    materials,
    nodes,
    scenes,
    defaultScene:
      doc.scene === undefined
        ? null
        : integer(doc.scene, "scene", 0, scenes.length - 1),
  };
}
export async function loadGltf(
  source: BrowserByteSource,
  o: GltfLoadOptions = {},
): Promise<GltfAsset> {
  const opts: GltfLoadOptions = { ...o };
  if (!opts.baseUrl && (typeof source === "string" || source instanceof URL))
    opts.baseUrl = String(source);
  return decodeGltf(await readByteSource(source, opts), opts);
}
/** Binary glTF preserves f32 attributes and u32 indices exactly. */
export function encodeGlb(input: MeshInput): Uint8Array {
  const m = cloneMesh(input),
    attributes: Record<string, number> = {},
    views: RecordValue[] = [],
    accessors: RecordValue[] = [],
    chunks: Uint8Array[] = [];
  let length = 0;
  function add(a: Float32Array | Uint32Array, type: string): number {
    const data = new Uint8Array(a.byteLength),
      dv = new DataView(data.buffer);
    for (let i = 0; i < a.length; i++)
      if (a instanceof Uint32Array) dv.setUint32(i * 4, a[i]!, true);
      else dv.setFloat32(i * 4, a[i]!, true);
    const view = views.length;
    views.push({ buffer: 0, byteOffset: length, byteLength: data.length });
    chunks.push(data);
    length += data.length;
    const id = accessors.length;
    accessors.push({
      bufferView: view,
      componentType: a instanceof Uint32Array ? 5125 : 5126,
      count: a.length / { VEC3: 3, VEC2: 2, VEC4: 4, SCALAR: 1 }[type]!,
      type,
    });
    return id;
  }
  attributes.POSITION = add(m.positions, "VEC3");
  const bounds = meshBounds(m);
  if (bounds)
    Object.assign(accessors[attributes.POSITION]!, {
      min: bounds.min,
      max: bounds.max,
    });
  if (m.normals.length) attributes.NORMAL = add(m.normals, "VEC3");
  if (m.uvs.length) attributes.TEXCOORD_0 = add(m.uvs, "VEC2");
  if (m.tangents.length) attributes.TANGENT = add(m.tangents, "VEC4");
  const indices = add(m.indices, "SCALAR");
  const json = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "2.0", generator: "Forge3D" },
        buffers: [{ byteLength: length }],
        bufferViews: views,
        accessors,
        meshes: [{ primitives: [{ attributes, indices, mode: 4 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      }),
    ),
    padded = Math.ceil(json.length / 4) * 4,
    out = new Uint8Array(28 + padded + length);
  meshLimit(out.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, padded, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + padded);
  out.set(json, 20);
  dv.setUint32(20 + padded, length, true);
  dv.setUint32(24 + padded, 0x004e4942, true);
  let cursor = 28 + padded;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
