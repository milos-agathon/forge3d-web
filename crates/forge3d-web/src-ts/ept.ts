import type {
  PointData,
  PointVec3,
  PointBounds,
  PointNode,
  PointDatasetOptions,
  PointCloudDataset,
} from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import { OctreeKey } from "./pointcloud-octree.js";
import { decodeLaz } from "./laz-decoder.js";
import {
  pointError,
  pointInteger,
  pointFinite,
  pointLimit,
  pointJson,
  pointUrl,
  pointLive,
  checkBounds,
  pointCancelled,
  pointAwait,
} from "./pointcloud-common.js";
export interface EptDimension {
  name: string;
  type: "signed" | "unsigned" | "floating";
  size: number;
  scale?: number;
  offset?: number;
}
export interface EptInfo {
  bounds: number[];
  boundsConforming?: number[];
  points: number;
  span: number;
  schema: EptDimension[];
  dataType: "binary" | "laszip" | "zstandard";
  hierarchyType: "json";
  srs?: { wkt?: string; authority?: string; horizontal?: string | number };
}
export function parseEptBinary(
  bytes: Uint8Array,
  schema: readonly EptDimension[],
  o: { maxBytes?: number; signal?: AbortSignal } = {},
): PointData {
  let stride = 0;
  const dimensions = new Map<string, { dim: EptDimension; offset: number }>();
  for (const dim of schema) {
    if (
      !dim ||
      typeof dim !== "object" ||
      typeof dim.name !== "string" ||
      !dim.name ||
      dimensions.has(dim.name) ||
      !["signed", "unsigned", "floating"].includes(dim.type) ||
      ![1, 2, 4, 8].includes(dim.size) ||
      (dim.type === "floating" && ![4, 8].includes(dim.size))
    )
      pointError("Invalid EPT dimension");
    if (dim.scale !== undefined) pointFinite(dim.scale, "schema scale");
    if (dim.offset !== undefined) pointFinite(dim.offset, "schema offset");
    dimensions.set(dim.name, { dim, offset: stride });
    stride += dim.size;
  }
  if (
    !stride ||
    bytes.length % stride ||
    !["X", "Y", "Z"].every((n) => dimensions.has(n))
  )
    pointError("Invalid EPT binary schema/length");
  const count = bytes.length / stride;
  pointLimit(count * 30, o.maxBytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    positions = new Float64Array(count * 3),
    rgb = ["Red", "Green", "Blue"].every((n) => dimensions.has(n)),
    colors = rgb ? new Uint8Array(count * 3) : undefined,
    intensities = dimensions.has("Intensity")
      ? new Uint16Array(count)
      : undefined,
    classifications = dimensions.has("Classification")
      ? new Uint8Array(count)
      : undefined;
  function read(name: string, i: number): number {
    const { dim: d, offset } = dimensions.get(name)!,
      b = i * stride + offset;
    let n: number;
    if (d.type === "floating")
      n = d.size === 4 ? v.getFloat32(b, true) : v.getFloat64(b, true);
    else if (d.size === 8) {
      const big =
        d.type === "signed" ? v.getBigInt64(b, true) : v.getBigUint64(b, true);
      if (
        big > BigInt(Number.MAX_SAFE_INTEGER) ||
        big < BigInt(Number.MIN_SAFE_INTEGER)
      )
        pointError("EPT integer loses precision");
      n = Number(big);
    } else
      n =
        d.type === "signed"
          ? d.size === 1
            ? v.getInt8(b)
            : d.size === 2
              ? v.getInt16(b, true)
              : v.getInt32(b, true)
          : d.size === 1
            ? v.getUint8(b)
            : d.size === 2
              ? v.getUint16(b, true)
              : v.getUint32(b, true);
    return pointFinite(n * (d.scale ?? 1) + (d.offset ?? 0), name);
  }
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) pointCancelled(o.signal);
    ["X", "Y", "Z"].forEach((n, a) => (positions[i * 3 + a] = read(n, i)));
    if (colors)
      ["Red", "Green", "Blue"].forEach(
        (n, a) =>
          (colors[i * 3 + a] =
            dimensions.get(n)!.dim.size === 1 ? read(n, i) : read(n, i) / 256),
      );
    if (intensities) intensities[i] = read("Intensity", i);
    if (classifications) classifications[i] = read("Classification", i);
  }
  return {
    positions,
    ...(colors ? { colors } : {}),
    ...(intensities ? { intensities } : {}),
    ...(classifications ? { classifications } : {}),
  };
}
export class EptDataset implements PointCloudDataset {
  readonly bounds: PointBounds;
  readonly totalPoints: number;
  readonly crs: string | undefined;
  readonly hierarchy = new Map<string, number>();
  readonly #pages = new Set<string>();
  readonly #pending = new Map<string, Promise<void>>();
  private constructor(
    readonly url: string,
    readonly info: EptInfo,
    readonly io: PointSource,
  ) {
    this.bounds = checkBounds({
      min: info.bounds.slice(0, 3) as unknown as PointVec3,
      max: info.bounds.slice(3, 6) as unknown as PointVec3,
    });
    this.totalPoints = info.points;
    this.crs =
      info.srs?.wkt ??
      (info.srs?.authority && info.srs?.horizontal !== undefined
        ? `${info.srs.authority}:${info.srs.horizontal}`
        : undefined);
  }
  static async open(
    url: string | URL,
    options: PointDatasetOptions = {},
  ): Promise<EptDataset> {
    const io = new PointSource(options);
    try {
      const info = pointJson(await io.read(String(url))) as unknown as EptInfo;
      if (
        !Array.isArray(info.bounds) ||
        info.bounds.length !== 6 ||
        !Array.isArray(info.schema) ||
        info.hierarchyType !== "json" ||
        !["binary", "laszip", "zstandard"].includes(info.dataType)
      )
        pointError("Invalid EPT metadata");
      pointInteger(info.points, "EPT points");
      pointInteger(info.span, "EPT span", 1);
      parseEptBinary(new Uint8Array(), info.schema);
      const d = new EptDataset(String(url), info, io);
      await d.#page("0-0-0-0");
      return d;
    } catch (e) {
      io.dispose();
      throw e;
    }
  }
  async #page(key: string, signal?: AbortSignal): Promise<void> {
    if (this.#pages.has(key)) pointError("Cyclic EPT hierarchy");
    const page = pointJson(
      await this.io.read(
        pointUrl(`ept-hierarchy/${key}.json`, this.url),
        signal,
      ),
    );
    pointLimit(
      (this.hierarchy.size + Object.keys(page).length) * 64,
      this.io.maxNodes * 64,
    );
    for (const [k, v] of Object.entries(page)) {
      OctreeKey.parse(k);
      if (typeof v !== "number") pointError("Invalid EPT hierarchy count");
      pointInteger(v, "EPT count", -1, this.io.maxPoints);
      if (this.hierarchy.has(k) && this.hierarchy.get(k) !== -1)
        pointError("Duplicate EPT hierarchy node");
    }
    for (const [k, v] of Object.entries(page))
      this.hierarchy.set(k, v as number);
    this.#pages.add(key);
  }
  #node(key: string): PointNode {
    pointLive(this.io.disposed);
    const k = OctreeKey.parse(key),
      n = this.hierarchy.get(key);
    if (n === undefined) pointError("EPT node missing");
    return {
      key,
      depth: k.depth,
      bounds: k.bounds(this.bounds),
      pointCount: Math.max(0, n),
      spacing:
        (this.bounds.max[0] - this.bounds.min[0]) /
        this.info.span /
        2 ** k.depth,
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
  async #resolve(key: string, signal?: AbortSignal): Promise<void> {
    if (this.hierarchy.get(key) === -1) {
      let pending = this.#pending.get(key);
      if (!pending) {
        pending = this.#page(key).finally(() => this.#pending.delete(key));
        this.#pending.set(key, pending);
      }
      await pointAwait(pending, this.io.signal(signal));
    }
  }
  async children(key: string, signal?: AbortSignal): Promise<PointNode[]> {
    this.io.signal(signal);
    await this.#resolve(key, signal);
    return this.#node(key).children.map((k) => this.#node(k));
  }
  async readPoints(key: string, signal?: AbortSignal): Promise<PointData> {
    this.io.signal(signal);
    await this.#resolve(key, signal);
    const n = this.hierarchy.get(key);
    if (n === undefined || n < 0) pointError("EPT data node missing");
    const cached = this.io.cached(key);
    if (cached) return cached;
    if (!n) return { positions: new Float64Array() };
    if (this.info.dataType === "zstandard")
      throw new (await import("./index.js")).Forge3DError(
        "UNSUPPORTED_FEATURE",
        "EPT zstandard requires a registered decoder",
        { reason: "ept-zstandard-unavailable" },
      );
    const format = this.info.dataType,
      bytes = await this.io.read(
        pointUrl(
          `ept-data/${key}.${format === "binary" ? "bin" : "laz"}`,
          this.url,
        ),
        signal,
      );
    const data = await this.io.decode(
      format === "binary"
        ? {
            kind: "ept-binary",
            bytes,
            schema: this.info.schema,
            maxBytes: this.io.maxBytes,
          }
        : { kind: "laz-file", bytes, maxBytes: this.io.maxBytes },
      async (s) =>
        format === "binary"
          ? parseEptBinary(bytes, this.info.schema, {
              maxBytes: this.io.maxBytes,
              signal: s,
            })
          : decodeLaz(bytes, { maxBytes: this.io.maxBytes, signal: s }),
      signal,
    );
    if (data.positions.length / 3 !== n)
      pointError("EPT point count differs from hierarchy");
    return this.io.admit(key, data);
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
