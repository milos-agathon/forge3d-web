import type { PointData, PointVec3, PointBounds } from "./pointcloud-types.js";
import {
  pointError,
  pointLimit,
  pointU64,
  pointFinite,
  checkBounds,
  pointCancelled,
} from "./pointcloud-common.js";
export interface LasHeader {
  version: string;
  headerSize: number;
  pointOffset: number;
  vlrCount: number;
  pointFormat: number;
  recordLength: number;
  pointCount: number;
  compressed: boolean;
  scale: PointVec3;
  offset: PointVec3;
  bounds: PointBounds;
}
const LENGTHS = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
export function parseLasHeader(bytes: Uint8Array): LasHeader {
  if (
    bytes.length < 227 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "LASF"
  )
    pointError("Invalid LAS header", "invalid-las");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    major = v.getUint8(24),
    minor = v.getUint8(25),
    headerSize = v.getUint16(94, true),
    format = v.getUint8(104) & 63,
    recordLength = v.getUint16(105, true);
  if (
    major !== 1 ||
    minor > 4 ||
    headerSize < 227 ||
    (minor === 4 && (headerSize < 375 || bytes.length < 375)) ||
    format > 10 ||
    recordLength < LENGTHS[format]!
  )
    pointError("Invalid LAS version/record layout", "invalid-las");
  const pointOffset = v.getUint32(96, true),
    vlrCount = v.getUint32(100, true);
  if (pointOffset < headerSize || vlrCount > 100_000)
    pointError("Invalid LAS offsets/VLR count");
  const scale = [0, 1, 2].map((i) =>
      v.getFloat64(131 + i * 8, true),
    ) as unknown as PointVec3,
    offset = [0, 1, 2].map((i) =>
      v.getFloat64(155 + i * 8, true),
    ) as unknown as PointVec3,
    max = [179, 195, 211].map((i) =>
      v.getFloat64(i, true),
    ) as unknown as PointVec3,
    min = [187, 203, 219].map((i) =>
      v.getFloat64(i, true),
    ) as unknown as PointVec3;
  for (const x of scale)
    if (!Number.isFinite(x) || x <= 0) pointError("Invalid LAS scale");
  for (const x of offset) pointFinite(x, "LAS offset");
  const pointCount = minor === 4 ? pointU64(v, 247) : v.getUint32(107, true);
  return {
    version: `${major}.${minor}`,
    headerSize,
    pointOffset,
    vlrCount,
    pointFormat: format,
    recordLength,
    pointCount,
    compressed: !!(v.getUint8(104) & 128),
    scale,
    offset,
    bounds: checkBounds({ min, max }),
  };
}
export function parseLasRecords(
  bytes: Uint8Array,
  count: number,
  header: LasHeader,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): PointData {
  const { recordLength: stride, pointFormat: format } = header;
  if (!Number.isSafeInteger(count) || count < 0 || stride < LENGTHS[format]!)
    pointError("Invalid LAS record layout");
  const rgbOffset =
    format === 2
      ? 20
      : format === 3 || format === 5
        ? 28
        : format === 7 || format === 8 || format === 10
          ? 30
          : null;
  pointLimit(
    count * (24 + 2 + 1 + (rgbOffset === null ? 0 : 3)),
    options.maxBytes,
  );
  if (bytes.length !== count * stride)
    pointError("LAS record length/count mismatch", "truncated-points");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    positions = new Float64Array(count * 3),
    intensities = new Uint16Array(count),
    classifications = new Uint8Array(count),
    colors = rgbOffset === null ? undefined : new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) pointCancelled(options.signal);
    const b = i * stride;
    for (let a = 0; a < 3; a++)
      positions[i * 3 + a] =
        v.getInt32(b + a * 4, true) * header.scale[a]! + header.offset[a]!;
    intensities[i] = v.getUint16(b + 12, true);
    classifications[i] =
      v.getUint8(b + (format >= 6 ? 16 : 15)) & (format >= 6 ? 255 : 31);
    if (colors)
      for (let a = 0; a < 3; a++)
        colors[i * 3 + a] = v.getUint16(b + rgbOffset! + a * 2, true) >> 8;
  }
  return {
    positions,
    intensities,
    classifications,
    ...(colors ? { colors } : {}),
  };
}
