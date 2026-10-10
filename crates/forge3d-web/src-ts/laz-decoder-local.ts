import { Forge3DError } from "./index.js";
import { readByteSource } from "./browser-io.js";
import {
  pointError,
  pointLimit,
  pointCancelled,
  pointInteger,
} from "./pointcloud-common.js";
import { parseLasHeader, parseLasRecords } from "./pointcloud-las.js";
import type { LasHeader } from "./pointcloud-las.js";
import type { PointData } from "./pointcloud-types.js";
interface NativeDecoder {
  delete(): void;
  getPoint(pointer: number): void;
}
interface ChunkDecoder extends NativeDecoder {
  open(format: number, length: number, pointer: number): void;
}
interface FileDecoder extends NativeDecoder {
  open(pointer: number, length: number): void;
  getCount(): number;
  getPointLength(): number;
  getPointFormat(): number;
}
interface LazModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  ChunkDecoder: new () => ChunkDecoder;
  LASZip: new () => FileDecoder;
}
type Factory = (o: {
  wasmBinary: Uint8Array;
  printErr: (s: string) => void;
}) => Promise<LazModule>;
let modulePromise: Promise<LazModule> | undefined;
async function module(): Promise<LazModule> {
  modulePromise ??= (async () => {
    const url = new URL("../assets/laz/laz-perf.js", import.meta.url),
      wasm = new URL("../assets/laz/laz-perf.wasm", import.meta.url);
    const factory = (
      (await import(/* @vite-ignore */ url.href)) as { default: Factory }
    ).default;
    const bytes = await readByteSource(wasm, { maxBytes: 1024 * 1024 });
    return factory({ wasmBinary: bytes, printErr: () => {} });
  })().catch((e) => {
    modulePromise = undefined;
    throw new Forge3DError(
      "WASM_LOAD_FAILED",
      "LAZ decoder could not be loaded",
      { reason: "laz-codec-unavailable", message: String(e) },
    );
  });
  return modulePromise;
}
import type { LazDecodeOptions } from "./laz-decoder.js";
/** Copies only one record out of the WASM heap at a time; all native allocations are freed. */
async function decode(
  bytes: Uint8Array,
  header: LasHeader,
  count: number,
  chunk: boolean,
  o: LazDecodeOptions,
): Promise<PointData> {
  validateLazDecode(bytes, header, count, chunk, o);
  const m = await module();
  pointCancelled(o.signal);
  let input = 0,
    output = 0,
    decoder: NativeDecoder | undefined;
  try {
    input = m._malloc(bytes.length + 64);
    output = m._malloc(header.recordLength);
    if (!input || !output)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "LAZ heap allocation failed",
      );
    m.HEAPU8.fill(0, input, input + bytes.length + 64);
    m.HEAPU8.set(bytes, input);
    if (chunk) {
      const d = new m.ChunkDecoder();
      decoder = d;
      d.open(header.pointFormat, header.recordLength, input);
    } else {
      const d = new m.LASZip();
      decoder = d;
      d.open(input, bytes.length);
      if (
        d.getCount() !== count ||
        d.getPointLength() !== header.recordLength ||
        d.getPointFormat() !== header.pointFormat
      )
        pointError("LAZ header/decoder mismatch", "invalid-laz");
    }
    const raw = new Uint8Array(count * header.recordLength);
    for (let i = 0; i < count; i++) {
      if (i % 8192 === 0) {
        if (i) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        pointCancelled(o.signal);
      }
      decoder.getPoint(output);
      raw.set(
        m.HEAPU8.subarray(output, output + header.recordLength),
        i * header.recordLength,
      );
    }
    return parseLasRecords(raw, count, header, o);
  } catch (e) {
    if (e instanceof Forge3DError) throw e;
    return pointError("LAZ decompression failed", "invalid-laz");
  } finally {
    decoder?.delete();
    if (output) m._free(output);
    if (input) m._free(input);
  }
}
/** Validate before spawning a worker, and again inside it before native allocation. */
export function validateLazDecode(
  bytes: Uint8Array, header: LasHeader, count: number, chunk: boolean,
  o: LazDecodeOptions,
): void {
  pointCancelled(o.signal);
  pointInteger(count, "LAZ count");
  pointLimit(count * header.recordLength, o.maxBytes);
  pointLimit(bytes.length, o.maxBytes);
  if (chunk) {
    if (bytes.length < header.recordLength + 8)
      pointError("Truncated LAZ chunk", "invalid-laz");
    if (header.pointFormat >= 6) {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      if (v.getUint32(header.recordLength, true) !== count)
        pointError(
          "LAZ layered chunk count differs from hierarchy",
          "invalid-laz",
        );
      // LASzip layered 1.4: raw seed, count, nine POINT14 sizes, optional
      // RGB/NIR size and one size per extra byte, then those exact streams.
      const base =
        header.pointFormat === 6 ? 30 : header.pointFormat === 7 ? 36 : 38;
      const layers =
        9 +
        (header.pointFormat >= 7 ? 1 : 0) +
        (header.pointFormat === 8 ? 1 : 0) +
        (header.recordLength - base);
      const start = header.recordLength + 4,
        end = start + layers * 4;
      if (layers < 9 || end > bytes.length)
        pointError("Truncated LAZ layer sizes", "invalid-laz");
      let encoded = 0;
      for (let i = 0; i < layers; i++)
        encoded += v.getUint32(start + i * 4, true);
      if (encoded !== bytes.length - end)
        pointError("LAZ layer lengths differ from chunk bytes", "invalid-laz");
    }
  }
}
/** Internal worker-only implementation; public calls use owned workers. */
export async function decodeLazLocal(
  bytes: Uint8Array,
  o: LazDecodeOptions = {},
): Promise<PointData> {
  const h = parseLasHeader(bytes);
  if (h.pointOffset > bytes.length) pointError("Truncated LAS/LAZ file");
  if (!h.compressed)
    return parseLasRecords(
      bytes.subarray(
        h.pointOffset,
        h.pointOffset + h.pointCount * h.recordLength,
      ),
      h.pointCount,
      h,
      o,
    );
  return decode(bytes, h, h.pointCount, false, o);
}
export async function decodeLazChunkLocal(
  bytes: Uint8Array,
  header: LasHeader,
  count: number,
  o: LazDecodeOptions = {},
): Promise<PointData> {
  if (!header.compressed) pointError("COPC requires compressed LAS records");
  if (![6, 7, 8].includes(header.pointFormat))
    pointError("COPC requires LAS point format 6/7/8", "invalid-copc");
  return decode(bytes, header, count, true, o);
}
