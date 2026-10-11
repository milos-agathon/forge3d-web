import type {
  PointData,
  PointBounds,
  PointVec3,
  PointNode,
  PointDatasetOptions,
  PointCloudDataset,
} from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import { parseLasHeader } from "./pointcloud-las.js";
import type { LasHeader } from "./pointcloud-las.js";
import { decodeLazChunk } from "./laz-decoder.js";
import { OctreeKey } from "./pointcloud-octree.js";
import {
  pointError,
  pointInteger,
  pointU64,
  pointLimit,
  pointLive,
  checkBounds,
  pointCancelled,
  pointAwait,
} from "./pointcloud-common.js";
export interface CopcInfo {
  center: PointVec3;
  halfSize: number;
  spacing: number;
  rootHierarchyOffset: number;
  rootHierarchySize: number;
  gpsTimeMinimum: number;
  gpsTimeMaximum: number;
}
export interface CopcHierarchyEntry {
  key: string;
  offset: number;
  byteSize: number;
  pointCount: number;
}
export function parseCopcHierarchy(bytes: Uint8Array): CopcHierarchyEntry[] {
  if (bytes.length % 32)
    pointError("Truncated COPC hierarchy", "invalid-copc-hierarchy");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    entries: CopcHierarchyEntry[] = [],
    seen = new Set<string>();
  for (let b = 0; b < bytes.length; b += 32) {
    const key = new OctreeKey(
        v.getInt32(b, true),
        v.getInt32(b + 4, true),
        v.getInt32(b + 8, true),
        v.getInt32(b + 12, true),
      ).toString(),
      offset = pointU64(v, b + 16),
      byteSize = v.getInt32(b + 24, true),
      pointCount = v.getInt32(b + 28, true);
    if (
      seen.has(key) ||
      pointCount < -1 ||
      byteSize < 0 ||
      (pointCount !== 0 && byteSize === 0) ||
      (pointCount === -1 && byteSize % 32)
    )
      pointError("Invalid COPC hierarchy entry", "invalid-copc-hierarchy");
    seen.add(key);
    entries.push({ key, offset, byteSize, pointCount });
  }
  return entries;
}
export class CopcDataset implements PointCloudDataset {
  readonly crs: string | undefined;
  readonly bounds: PointBounds;
  readonly totalPoints: number;
  readonly hierarchy = new Map<string, CopcHierarchyEntry>();
  readonly #pages = new Set<string>();
  readonly #pending = new Map<string, Promise<void>>();
  private constructor(
    readonly source: string | URL | Blob,
    readonly header: LasHeader,
    readonly info: CopcInfo,
    readonly io: PointSource,
    crs?: string,
  ) {
    this.totalPoints = header.pointCount;
    this.crs = crs;
    this.bounds = checkBounds({
      min: info.center.map((x) => x - info.halfSize) as unknown as PointVec3,
      max: info.center.map((x) => x + info.halfSize) as unknown as PointVec3,
    });
  }
  static async open(
    source: string | URL | Blob,
    options: PointDatasetOptions = {},
  ): Promise<CopcDataset> {
    const io = new PointSource(options);
    try {
      const h = parseLasHeader(await io.range(source, 0, 375));
      if (
        h.version !== "1.4" ||
        !h.compressed ||
        ![6, 7, 8].includes(h.pointFormat)
      )
        pointError("COPC requires LAS 1.4 LAZ format 6/7/8", "invalid-copc");
      const bytes = await io.range(
          source,
          h.headerSize,
          h.pointOffset - h.headerSize,
        ),
        v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      let cursor = 0,
        info: CopcInfo | undefined,
        crs: string | undefined;
      for (let i = 0; i < h.vlrCount; i++) {
        if (cursor + 54 > bytes.length) pointError("Truncated COPC VLR");
        const user = new TextDecoder()
            .decode(bytes.subarray(cursor + 2, cursor + 18))
            .replace(/\0.*$/u, ""),
          id = v.getUint16(cursor + 18, true),
          n = v.getUint16(cursor + 20, true);
        cursor += 54;
        if (cursor + n > bytes.length) pointError("Truncated COPC VLR payload");
        const data = bytes.subarray(cursor, cursor + n),
          d = new DataView(data.buffer, data.byteOffset, data.length);
        if (user === "copc" && id === 1) {
          if (i !== 0 || info || n !== 160) pointError("Invalid COPC info VLR");
          const center = [0, 1, 2].map((a) =>
            d.getFloat64(a * 8, true),
          ) as unknown as PointVec3;
          info = {
            center,
            halfSize: d.getFloat64(24, true),
            spacing: d.getFloat64(32, true),
            rootHierarchyOffset: pointU64(d, 40),
            rootHierarchySize: pointU64(d, 48),
            gpsTimeMinimum: d.getFloat64(56, true),
            gpsTimeMaximum: d.getFloat64(64, true),
          };
          if (
            center.some((x) => !Number.isFinite(x)) ||
            !(info.halfSize > 0) ||
            !Number.isFinite(info.halfSize) ||
            !(info.spacing > 0) ||
            !Number.isFinite(info.spacing) ||
            info.rootHierarchySize % 32 ||
            !info.rootHierarchySize
          )
            pointError("Invalid COPC info");
        }
        if (user === "LASF_Projection" && id === 2112)
          crs = new TextDecoder("utf-8", { fatal: true })
            .decode(data)
            .replace(/\0+$/u, "");
        cursor += n;
      }
      if (!info) pointError("Missing COPC info VLR", "invalid-copc");
      const dataset = new CopcDataset(source, h, info, io, crs);
      await dataset.#page(info.rootHierarchyOffset, info.rootHierarchySize);
      return dataset;
    } catch (e) {
      io.dispose();
      throw e;
    }
  }
  async #page(
    offset: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const id = `${offset}:${size}`;
    if (this.#pages.has(id))
      pointError("Cyclic COPC hierarchy page", "invalid-copc-hierarchy");
    pointLimit(size, this.io.maxBytes);
    const entries = parseCopcHierarchy(
      await this.io.range(this.source, offset, size, signal),
    );
    pointLimit(
      (this.hierarchy.size + entries.length) * 64,
      this.io.maxNodes * 64,
    );
    pointCancelled(this.io.signal(signal));
    for (const e of entries) {
      pointInteger(e.pointCount, "COPC point count", -1, this.io.maxPoints);
      const old = this.hierarchy.get(e.key);
      if (old && old.pointCount !== -1)
        pointError("Duplicate COPC hierarchy key");
      const total = this.io.scheduler.fileSize(this.source);
      if (total !== undefined && e.offset + e.byteSize > total)
        pointError("COPC hierarchy references bytes outside file");
    }
    for (const e of entries) this.hierarchy.set(e.key, e);
    this.#pages.add(id);
  }
  async #resolve(key: string, signal?: AbortSignal): Promise<void> {
    const e = this.hierarchy.get(key);
    if (e?.pointCount === -1) {
      const id = `${e.offset}:${e.byteSize}`;
      let pending = this.#pending.get(id);
      if (!pending) {
        pending = this.#page(e.offset, e.byteSize).finally(() =>
          this.#pending.delete(id),
        );
        this.#pending.set(id, pending);
      }
      await pointAwait(pending, this.io.signal(signal));
    }
  }
  #node(key: string): PointNode {
    pointLive(this.io.disposed);
    const k = OctreeKey.parse(key),
      e = this.hierarchy.get(key);
    if (!e) pointError("COPC node missing");
    return {
      key,
      depth: k.depth,
      bounds: k.bounds(this.bounds),
      pointCount: Math.max(0, e.pointCount),
      spacing: this.info.spacing / 2 ** k.depth,
      children:
        k.depth === 30
          ? []
          : Array.from({ length: 8 }, (_, o) => k.child(o).toString()).filter(
              (x) => this.hierarchy.has(x),
            ),
    };
  }
  rootNode(): PointNode {
    return this.#node("0-0-0-0");
  }
  async children(key: string, signal?: AbortSignal): Promise<PointNode[]> {
    this.io.signal(signal);
    await this.#resolve(key, signal);
    return this.#node(key).children.map((k) => this.#node(k));
  }
  async readPoints(key: string, signal?: AbortSignal): Promise<PointData> {
    this.io.signal(signal);
    const cached = this.io.cached(key);
    if (cached) return cached;
    await this.#resolve(key, signal);
    const e = this.hierarchy.get(key);
    if (!e || e.pointCount < 0) pointError("COPC data node missing");
    if (!e.pointCount) return { positions: new Float64Array() };
    const bytes = await this.io.range(
      this.source,
      e.offset,
      e.byteSize,
      signal,
    );
    const result = await this.io.decode(
      {
        kind: "laz-chunk",
        bytes,
        header: this.header,
        count: e.pointCount,
        maxBytes: this.io.maxBytes,
      },
      (s) =>
        decodeLazChunk(bytes, this.header, e.pointCount, {
          signal: s,
          maxBytes: this.io.maxBytes,
        }),
      signal,
    );
    return this.io.admit(key, result);
  }
  stats() {
    return {
      ...this.io.stats(),
      nodeCount: this.hierarchy.size,
      totalPoints: this.totalPoints,
    };
  }
  dispose(): void {
    this.io.dispose();
    this.hierarchy.clear();
    this.#pages.clear();
    this.#pending.clear();
  }
}
