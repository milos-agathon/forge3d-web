import { meshError, meshInteger, MAX_MESH_BYTES } from "./mesh.js";
type RecordValue = Record<string, unknown>;
function record(v: unknown, name: string): RecordValue {
  if (!v || typeof v !== "object" || Array.isArray(v))
    meshError(`${name} must be an object`);
  return v as RecordValue;
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

/** Checked accessor table. Owns layout and sparse validation before output admission.
 * Each materialization returns independently owned arrays, even for shared accessors.
 */
export function checkedAccessors(
  views: RecordValue[], accessors: RecordValue[], buffers: Uint8Array[],
  admit: (bytes: number) => void,
): (id: number, shape: string, indices?: boolean) => Float32Array | Uint32Array {
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
    const outputBytes = count * width * 4;
    // Validate the complete read plan before admitting or materializing output.
    const writes: ((out: Float32Array | Uint32Array) => void)[] = [];
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
        (data.byteOffset + off) % size ||
        stride % size ||
        (count && off + (count - 1) * stride + width * size > data.length)
      )
        meshError("accessor exceeds view or has invalid alignment");
      const v = new DataView(data.buffer, data.byteOffset, data.length);
      writes.push((out) => {
      for (let i = 0; i < count; i++)
        for (let j = 0; j < width; j++)
          out[i * width + j] = scalar(
            v,
            off + i * stride + j * size,
            type,
            normalized,
          );
      });
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
      if ((iv.byteOffset+io)%is || (vv.byteOffset+vo)%size || io + n * is > iv.length || vo + n * width * size > vv.length)
        meshError("sparse accessor exceeds view");
      const idv = new DataView(iv.buffer, iv.byteOffset, iv.length),
        valv = new DataView(vv.buffer, vv.byteOffset, vv.length);
      let previous = -1;
      for (let k = 0; k < n; k++) {
        const i = scalar(idv, io + k * is, it, false);
        if (i <= previous || i >= count)
          meshError("sparse indices must increase within accessor");
        previous = i;
      }
      writes.push((out) => {
      for (let k = 0; k < n; k++) {
        const i = scalar(idv, io + k * is, it, false);
        for (let j = 0; j < width; j++)
          out[i * width + j] = scalar(
            valv,
            vo + (k * width + j) * size,
            type,
            normalized,
          );
      }
      });
    }
    admit(outputBytes);
    const out = indices ? new Uint32Array(count * width) : new Float32Array(count * width);
    for (const write of writes) write(out);
    return out;
  }
  return accessor;
}
