import { Forge3DError } from "./index.js";
import {
  pointError,
  pointJson,
  pointInteger,
  pointLimit,
  pointCancelled,
} from "./pointcloud-common.js";
import { validatePointData } from "./pointcloud-buffer.js";
import type { PointData, PointVec3 } from "./pointcloud-types.js";
import { decodeGltf } from "./mesh-gltf.js";
import type { GltfLoadOptions, GltfAsset } from "./mesh-gltf.js";
export interface TileTables {
  featureTable: Record<string, unknown>;
  featureBinary: Uint8Array;
  batchTable: Record<string, unknown>;
  batchBinary: Uint8Array;
  payload: Uint8Array;
}
export function parseTileTables(
  bytes: Uint8Array,
  magic: "pnts" | "b3dm",
  maxBytes?: number,
): TileTables {
  pointLimit(bytes.length, maxBytes);
  if (
    bytes.length < 28 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== magic
  )
    pointError(`Invalid ${magic} header`, "invalid-tile-content");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (v.getUint32(4, true) !== 1 || v.getUint32(8, true) !== bytes.length)
    pointError("Invalid tile version/byteLength");
  const sizes = [12, 16, 20, 24].map((i) => v.getUint32(i, true));
  let cursor = 28;
  const sections: Uint8Array[] = [];
  for (const size of sizes) {
    if (cursor + size > bytes.length) pointError("Truncated tile tables");
    sections.push(bytes.subarray(cursor, cursor + size));
    cursor += size;
  }
  return {
    featureTable: sections[0]!.length ? pointJson(sections[0]!) : {},
    featureBinary: sections[1]!,
    batchTable: sections[2]!.length ? pointJson(sections[2]!) : {},
    batchBinary: sections[3]!,
    payload: bytes.subarray(cursor),
  };
}
function vector(
  table: Record<string, unknown>,
  binary: Uint8Array,
  name: string,
  length: number,
  defaultValue?: number[],
  component: "float32" | "uint8" = "float32",
): number[] {
  const field = table[name];
  if (field === undefined && defaultValue) return defaultValue;
  if (
    Array.isArray(field) &&
    field.length === length &&
    field.every((x) => typeof x === "number" && Number.isFinite(x))
  )
    return field as number[];
  if (field && typeof field === "object" && !Array.isArray(field)) {
    const offset = (field as { byteOffset?: number }).byteOffset,
      size = component === "float32" ? 4 : 1;
    pointInteger(offset!, "global byteOffset");
    if (offset! + length * size > binary.length)
      pointError("Truncated global tile property");
    const v = new DataView(binary.buffer, binary.byteOffset, binary.length),
      values = Array.from({ length }, (_, i) =>
        component === "float32"
          ? v.getFloat32(offset! + i * 4, true)
          : v.getUint8(offset! + i),
      );
    if (values.some((x) => !Number.isFinite(x)))
      pointError("Non-finite global tile property");
    return values;
  }
  return pointError(`Invalid ${name}`);
}
function globalCount(
  table: Record<string, unknown>,
  binary: Uint8Array,
  name: string,
): number {
  const value = table[name];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const start = (value as { byteOffset?: number }).byteOffset;
    pointInteger(start!, "global count byteOffset");
    if (start! + 4 > binary.length) pointError("Truncated global count");
    return new DataView(
      binary.buffer,
      binary.byteOffset,
      binary.length,
    ).getUint32(start!, true);
  }
  return pointInteger(value as number, name);
}
function offset(
  table: Record<string, unknown>,
  name: string,
  bytes: number,
  binary: Uint8Array,
): number | null {
  if (table[name] === undefined) return null;
  const v = table[name];
  if (!v || typeof v !== "object" || Array.isArray(v))
    pointError(`Invalid ${name}`);
  const n = (v as { byteOffset?: number }).byteOffset;
  pointInteger(n!, "byteOffset");
  if (n! + bytes > binary.length) pointError(`Truncated ${name}`);
  return n!;
}
export interface PntsContent {
  kind: "pnts";
  points: PointData;
  pointCount: number;
  rtcCenter: PointVec3;
  featureTable: Record<string, unknown>;
  batchTable: Record<string, unknown>;
  batchBinary: Uint8Array;
}
export function decodePnts(
  bytes: Uint8Array,
  o: { maxBytes?: number; signal?: AbortSignal } = {},
): PntsContent {
  pointCancelled(o.signal);
  const tables = parseTileTables(bytes, "pnts", o.maxBytes),
    t = tables.featureTable,
    b = tables.featureBinary;
  if (
    t.extensions &&
    typeof t.extensions === "object" &&
    "3DTILES_draco_point_compression" in t.extensions
  )
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "Draco PNTS requires a registered decoder",
      { reason: "pnts-draco-unavailable" },
    );
  const count = globalCount(t, b, "POINTS_LENGTH");
  pointLimit(count * 48, o.maxBytes);
  if (tables.payload.length) pointError("Unexpected PNTS trailing bytes");
  const pos = offset(t, "POSITION", count * 12, b),
    quant = offset(t, "POSITION_QUANTIZED", count * 6, b);
  if (pos === null && quant === null && count)
    pointError("PNTS position property missing");
  if (pos !== null && quant !== null)
    pointError("PNTS defines both position encodings");
  const rtc = vector(t, b, "RTC_CENTER", 3, [0, 0, 0]),
    scale =
      quant === null ? [1, 1, 1] : vector(t, b, "QUANTIZED_VOLUME_SCALE", 3),
    origin =
      quant === null ? [0, 0, 0] : vector(t, b, "QUANTIZED_VOLUME_OFFSET", 3),
    positions = new Float64Array(count * 3),
    v = new DataView(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) pointCancelled(o.signal);
    for (let a = 0; a < 3; a++)
      positions[i * 3 + a] =
        (pos !== null
          ? v.getFloat32(pos + (i * 3 + a) * 4, true)
          : (v.getUint16(quant! + (i * 3 + a) * 2, true) / 65535) * scale[a]! +
            origin[a]!) + rtc[a]!;
  }
  const rgba = offset(t, "RGBA", count * 4, b),
    rgb = offset(t, "RGB", count * 3, b),
    rgb565 = offset(t, "RGB565", count * 2, b),
    constant =
      t.CONSTANT_RGBA === undefined
        ? null
        : vector(t, b, "CONSTANT_RGBA", 4, undefined, "uint8");
  if (constant?.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    pointError("Invalid constant point color");
  if ([rgba, rgb, rgb565, constant].filter((x) => x !== null).length > 1)
    pointError("PNTS defines multiple color encodings");
  const c: 3 | 4 = rgba !== null || constant !== null ? 4 : 3,
    colors = new Uint8Array(count * c);
  for (let i = 0; i < count; i++) {
    if (constant) colors.set(constant, i * 4);
    else if (rgba !== null || rgb !== null)
      colors.set(
        b.subarray((rgba ?? rgb)! + i * c, (rgba ?? rgb)! + (i + 1) * c),
        i * c,
      );
    else if (rgb565 !== null) {
      const n = v.getUint16(rgb565 + i * 2, true);
      colors.set(
        [
          Math.round(((n >> 11) * 255) / 31),
          Math.round((((n >> 5) & 63) * 255) / 63),
          Math.round(((n & 31) * 255) / 31),
        ],
        i * 3,
      );
    } else colors.fill(255, i * 3, i * 3 + 3);
  }
  const normal = offset(t, "NORMAL", count * 12, b),
    oct = offset(t, "NORMAL_OCT16P", count * 2, b);
  if (normal !== null && oct !== null)
    pointError("PNTS defines both normal encodings");
  const normals =
    normal !== null || oct !== null ? new Float32Array(count * 3) : undefined;
  if (normals)
    for (let i = 0; i < count; i++) {
      if (normal !== null)
        for (let a = 0; a < 3; a++)
          normals[i * 3 + a] = v.getFloat32(normal + (i * 3 + a) * 4, true);
      else {
        let x = (b[oct! + i * 2]! / 255) * 2 - 1,
          y = (b[oct! + i * 2 + 1]! / 255) * 2 - 1,
          z = 1 - Math.abs(x) - Math.abs(y);
        if (z < 0) {
          const previous = x;
          x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
          y = (1 - Math.abs(previous)) * (y >= 0 ? 1 : -1);
        }
        const len = Math.hypot(x, y, z);
        normals.set([x / len, y / len, z / len], i * 3);
      }
    }
  let ids: Uint32Array | undefined;
  if (t.BATCH_ID !== undefined) {
    const prop = t.BATCH_ID as { componentType?: string },
      type = prop.componentType ?? "UNSIGNED_SHORT",
      size =
        type === "UNSIGNED_BYTE"
          ? 1
          : type === "UNSIGNED_SHORT"
            ? 2
            : type === "UNSIGNED_INT"
              ? 4
              : 0;
    if (!size) pointError("Invalid PNTS batch ID type");
    const start = offset(t, "BATCH_ID", count * size, b)!;
    const batches = pointInteger(t.BATCH_LENGTH as number, "BATCH_LENGTH", 1);
    ids = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      ids[i] =
        size === 1
          ? v.getUint8(start + i)
          : size === 2
            ? v.getUint16(start + i * 2, true)
            : v.getUint32(start + i * 4, true);
      if (ids[i]! >= batches) pointError("PNTS batch ID outside table");
    }
  }
  const points: PointData = {
    positions,
    colors,
    colorComponents: c,
    ...(normals ? { normals } : {}),
    ...(ids ? { ids } : {}),
  };
  validatePointData(points, o.maxBytes);
  return {
    kind: "pnts",
    points,
    pointCount: count,
    rtcCenter: rtc as unknown as PointVec3,
    featureTable: t,
    batchTable: tables.batchTable,
    batchBinary: tables.batchBinary.slice(),
  };
}
export interface B3dmContent {
  kind: "b3dm";
  gltf: GltfAsset;
  batchLength: number;
  rtcCenter: PointVec3;
  featureTable: Record<string, unknown>;
  batchTable: Record<string, unknown>;
  batchBinary: Uint8Array;
}
/** W16 unwraps b3dm. All glTF parsing belongs to the W15 decoder. */
export async function decodeB3dm(
  bytes: Uint8Array,
  o: GltfLoadOptions = {},
): Promise<B3dmContent> {
  pointCancelled(o.signal);
  const tables = parseTileTables(bytes, "b3dm", o.maxBytes),
    batchLength = globalCount(
      tables.featureTable,
      tables.featureBinary,
      "BATCH_LENGTH",
    ),
    rtc = vector(
      tables.featureTable,
      tables.featureBinary,
      "RTC_CENTER",
      3,
      [0, 0, 0],
    );
  if (
    tables.payload.length < 12 ||
    new TextDecoder().decode(tables.payload.subarray(0, 4)) !== "glTF"
  )
    pointError("B3DM payload must be GLB");
  return {
    kind: "b3dm",
    gltf: await decodeGltf(tables.payload, o),
    batchLength,
    rtcCenter: rtc as unknown as PointVec3,
    featureTable: tables.featureTable,
    batchTable: tables.batchTable,
    batchBinary: tables.batchBinary.slice(),
  };
}
