import type { BrowserByteSource, Forge3DMessageHandler } from "./index.js";
import { readByteSource } from "./browser-io.js";
import type {
  PointCloudDataset,
  PointDatasetOptions,
  PointData,
  PointNode,
  PointBounds,
} from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import { parseLasHeader } from "./pointcloud-las.js";
import type { LasHeader } from "./pointcloud-las.js";
import { decodeLaz, decodeLazChunk } from "./laz-decoder.js";
import { CopcDataset } from "./copc.js";
import { EptDataset, parseEptBinary } from "./ept.js";
import type { EptDimension } from "./ept.js";
import {
  boundsRadius,
  pointCancelled,
  pointError,
  pointLive,
  pointLimit,
} from "./pointcloud-common.js";
export class LazDataset implements PointCloudDataset {
  readonly crs = undefined;
  readonly totalPoints: number;
  readonly bounds: PointBounds;
  private constructor(
    readonly header: LasHeader,
    readonly io: PointSource,
  ) {
    this.totalPoints = header.pointCount;
    this.bounds = header.bounds;
  }
  static async open(
    source: BrowserByteSource,
    options: PointDatasetOptions = {},
  ): Promise<LazDataset> {
    const io = new PointSource(options);
    try {
      const bytes =
          typeof source === "string" || source instanceof URL
            ? await io.read(String(source))
            : await readByteSource(source, {
                signal: io.signal(),
                maxBytes: io.maxBytes,
              }),
        header = parseLasHeader(bytes);
      pointLimit(header.pointCount, io.maxPoints);
      const data = await io.decode(
        { kind: "laz-file", bytes, maxBytes: io.maxBytes },
        (s) => decodeLaz(bytes, { signal: s, maxBytes: io.maxBytes }),
      );
      io.admit("0-0-0-0", data);
      return new LazDataset(header, io);
    } catch (e) {
      io.dispose();
      throw e;
    }
  }
  rootNode(): PointNode {
    pointLive(this.io.disposed);
    return {
      key: "0-0-0-0",
      depth: 0,
      pointCount: this.totalPoints,
      bounds: this.bounds,
      spacing:
        boundsRadius(this.bounds) / Math.max(1, Math.cbrt(this.totalPoints)),
      children: [],
    };
  }
  async children(key: string, signal?: AbortSignal): Promise<PointNode[]> {
    this.io.signal(signal);
    if (key !== "0-0-0-0") pointError("LAS node missing");
    return [];
  }
  async readPoints(key: string, signal?: AbortSignal): Promise<PointData> {
    this.io.signal(signal);
    const data = this.io.cached(key);
    if (!data) pointError("LAS node missing");
    return data;
  }
  stats() {
    return this.io.stats();
  }
  dispose(): void {
    this.io.dispose();
  }
}
export const openCopc = CopcDataset.open;
export const openEpt = EptDataset.open;
export const openLaz = LazDataset.open;
export async function openPointCloud(
  source: string | URL | Blob,
  options: PointDatasetOptions & {
    format?: "copc" | "ept" | "las" | "laz";
  } = {},
): Promise<PointCloudDataset> {
  const name =
      typeof source === "string" || source instanceof URL
        ? String(source).split(/[?#]/u)[0]!.toLowerCase()
        : "",
    format =
      options.format ??
      (name.endsWith("ept.json")
        ? "ept"
        : name.endsWith(".copc.laz")
          ? "copc"
          : "laz");
  if (format === "ept") {
    if (source instanceof Blob) pointError("EPT needs a base URL");
    return EptDataset.open(source, options);
  }
  return format === "copc"
    ? CopcDataset.open(source, options)
    : LazDataset.open(source, options);
}
export type PointCloudWorkerRequest =
  | { kind: "laz-file"; bytes: Uint8Array; maxBytes?: number }
  | {
      kind: "laz-chunk";
      bytes: Uint8Array;
      header: LasHeader;
      count: number;
      maxBytes?: number;
    }
  | {
      kind: "ept-binary";
      bytes: Uint8Array;
      schema: EptDimension[];
      maxBytes?: number;
    };
/** The same handler runs in the W02 pool's real workers or its main-thread adapter. */
export function createPointCloudWorkerHandler(): Forge3DMessageHandler {
  return async (payload, context) => {
    const req = payload as PointCloudWorkerRequest;
    pointCancelled(context.signal);
    if (!req || typeof req !== "object" || !(req.bytes instanceof Uint8Array))
      pointError("Invalid point decoder request");
    const options = {
      signal: context.signal,
      ...(req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : {}),
    };
    switch (req.kind) {
      case "laz-file":
        return decodeLaz(req.bytes, options);
      case "laz-chunk":
        return decodeLazChunk(req.bytes, req.header, req.count, options);
      case "ept-binary":
        return parseEptBinary(req.bytes, req.schema, options);
      default:
        return pointError("Unknown point decoder request");
    }
  };
}
