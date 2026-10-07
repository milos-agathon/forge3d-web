import type {
  PointCloudDataset,
  PointData,
  PointView,
  PointTraversalOptions,
  PointStyle,
  PointVec3,
  VisiblePointNode,
} from "./pointcloud-types.js";
import { PointCloudTraverser } from "./pointcloud-octree.js";
import { PointBuffer } from "./pointcloud-buffer.js";
import {
  pointLimit,
  pointLive,
  pointCancelled,
  boundsCenter,
  pointError,
  pointInteger,
  POINT_MAX_BYTES,
} from "./pointcloud-common.js";
import type { CrsTransformer } from "./crs.js";
export interface AdaptivePointBudgetOptions {
  targetFrameMs?: number;
  minPoints?: number;
  maxPoints?: number;
  sampleFrames?: number;
}
/** Hysteresis adjusts only after a complete sample window; a hard maximum remains authoritative. */
export class AdaptivePointBudget {
  readonly targetFrameMs: number;
  readonly minPoints: number;
  readonly maxPoints: number;
  readonly sampleFrames: number;
  #times: number[] = [];
  constructor(options: AdaptivePointBudgetOptions = {}) {
    this.targetFrameMs = options.targetFrameMs ?? 16.7;
    this.minPoints = options.minPoints ?? 1000;
    this.maxPoints = options.maxPoints ?? 5_000_000;
    this.sampleFrames = options.sampleFrames ?? 30;
    if (!Number.isFinite(this.targetFrameMs) || this.targetFrameMs <= 0)
      pointError("Invalid adaptive frame target");
    pointInteger(this.minPoints, "minPoints", 0);
    pointInteger(this.maxPoints, "maxPoints", this.minPoints);
    pointInteger(this.sampleFrames, "sampleFrames", 1, 10000);
  }
  observe(frameMs: number, current: number): number {
    if (!Number.isFinite(frameMs) || frameMs < 0)
      pointError("Invalid frame time");
    pointInteger(current, "current budget", 0);
    this.#times.push(frameMs);
    if (this.#times.length < this.sampleFrames)
      return Math.min(current, this.maxPoints);
    const times = this.#times.sort((a, b) => a - b),
      p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    this.#times = [];
    const next =
      p95 > this.targetFrameMs
        ? Math.floor(current * 0.8)
        : p95 < this.targetFrameMs * 0.7
          ? current + Math.max(1, Math.ceil(current / 10))
          : current;
    return Math.max(this.minPoints, Math.min(this.maxPoints, next));
  }
}
export interface PointCloudLayerOptions extends PointTraversalOptions {
  name?: string;
  origin?: PointVec3;
  style?: PointStyle;
  maxBytes?: number;
  ownsDataset?: boolean;
  adaptiveBudget?: AdaptivePointBudgetOptions;
}
export interface PointCloudLayerSnapshot {
  name: string;
  origin: PointVec3;
  style: PointStyle;
  nodes: { key: string; buffer: PointBuffer }[];
}
/** Commits a camera selection only after every requested node is decoded and admitted. */
export class PointCloudLayer {
  readonly name: string;
  readonly origin: PointVec3;
  readonly traverser: PointCloudTraverser;
  #nodes = new Map<string, PointBuffer>();
  #selected: VisiblePointNode[] = [];
  #disposed = false;
  #update: AbortController | undefined;
  #style: PointStyle;
  readonly maxBytes: number;
  readonly ownsDataset: boolean;
  readonly adaptiveBudget: AdaptivePointBudget | undefined;
  constructor(
    readonly dataset: PointCloudDataset,
    options: PointCloudLayerOptions = {},
  ) {
    this.name = options.name ?? "pointcloud";
    const origin = options.origin ?? boundsCenter(dataset.bounds);
    if (origin.length !== 3 || origin.some((v) => !Number.isFinite(v)))
      pointError("Invalid point origin");
    this.origin = [...origin] as PointVec3;
    this.#style = normalizePointStyle(options.style);
    this.maxBytes = options.maxBytes ?? POINT_MAX_BYTES;
    pointInteger(this.maxBytes, "layer maxBytes", 1);
    this.traverser = new PointCloudTraverser({ mode: "add", ...options });
    this.ownsDataset = options.ownsDataset ?? false;
    this.adaptiveBudget = options.adaptiveBudget
      ? new AdaptivePointBudget({
          maxPoints: this.traverser.pointBudget,
          ...options.adaptiveBudget,
        })
      : undefined;
  }
  setStyle(style: PointStyle): void {
    pointLive(this.#disposed);
    this.#style = normalizePointStyle(style);
  }
  recordFrameTime(frameMs: number): void {
    pointLive(this.#disposed);
    if (this.adaptiveBudget)
      this.traverser.setPointBudget(
        this.adaptiveBudget.observe(frameMs, this.traverser.pointBudget),
      );
  }
  async update(
    view: PointView,
    signal?: AbortSignal,
  ): Promise<VisiblePointNode[]> {
    pointLive(this.#disposed);
    this.#update?.abort();
    const abort = new AbortController();
    this.#update = abort;
    const s = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const staged = new Map<string, PointBuffer>();
    try {
      const selected = await this.traverser.visibleNodes(this.dataset, view, s);
      let bytes = 0;
      for (const n of selected) {
        pointCancelled(s);
        if (n.pointCount === 0) continue;
        const previous = this.#nodes.get(n.key),
          buffer =
            previous ??
            new PointBuffer(
              await this.dataset.readPoints(n.key, s),
              this.maxBytes,
            );
        staged.set(n.key, buffer);
        bytes += buffer.cpuBytes + buffer.pointCount * 32;
        pointLimit(bytes, this.maxBytes);
      }
      pointCancelled(s);
      pointLive(this.#disposed);
      for (const [key, buffer] of this.#nodes)
        if (!staged.has(key)) buffer.dispose();
      this.#nodes = staged;
      this.#selected = selected;
      return selected.map((n) => structuredClone(n));
    } catch (e) {
      for (const [key, b] of staged)
        if (this.#nodes.get(key) !== b) b.dispose();
      throw e;
    } finally {
      if (this.#update === abort) this.#update = undefined;
    }
  }
  snapshot(): PointCloudLayerSnapshot {
    pointLive(this.#disposed);
    return {
      name: this.name,
      origin: [...this.origin] as PointVec3,
      style: { ...this.#style },
      nodes: Array.from(this.#nodes, ([key, buffer]) => ({ key, buffer })),
    };
  }
  stats() {
    return {
      nodesRendered: this.#nodes.size,
      pointsRendered: Array.from(this.#nodes.values()).reduce(
        (n, b) => n + b.pointCount,
        0,
      ),
      cpuBytes: Array.from(this.#nodes.values()).reduce(
        (n, b) => n + b.cpuBytes,
        0,
      ),
      gpuBytes: Array.from(this.#nodes.values()).reduce(
        (n, b) => n + b.pointCount * 32,
        0,
      ),
      pointBudget: this.traverser.pointBudget,
      selectedKeys: this.#selected.map((n) => n.key),
      disposed: this.#disposed,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#update?.abort();
    for (const b of this.#nodes.values()) b.dispose();
    this.#nodes.clear();
    this.#selected = [];
    if (this.ownsDataset) this.dataset.dispose();
  }
}
export function normalizePointStyle(
  style: PointStyle = {},
): Required<PointStyle> {
  const s = {
    pointSize: 2,
    shape: "circle" as const,
    colorMode: "rgb" as const,
    color: [1, 1, 1, 1] as const,
    opacity: 1,
    ...style,
  };
  if (
    !(s.pointSize > 0 && s.pointSize <= 128) ||
    !Number.isFinite(s.pointSize) ||
    !(s.opacity >= 0 && s.opacity <= 1) ||
    !["circle", "square"].includes(s.shape) ||
    !["rgb", "elevation", "intensity", "classification"].includes(
      s.colorMode,
    ) ||
    s.color.length !== 4 ||
    s.color.some((x) => !Number.isFinite(x) || x < 0 || x > 1)
  )
    pointError("Invalid point style");
  return { ...s, color: [...s.color] as [number, number, number, number] };
}
export async function reprojectPointData(
  data: PointData,
  transformer: CrsTransformer,
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<PointData> {
  const coords = await transformer.transformCoords(
    new Float64Array(data.positions),
    source,
    target,
    { stride: 3, ...(signal ? { signal } : {}) },
  );
  return { ...data, positions: coords };
}
