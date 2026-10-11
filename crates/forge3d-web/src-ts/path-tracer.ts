import { Forge3DError } from "./index.js";
import { Frame, HdrFrame } from "./frames.js";
import type {
  PathTracerOptions,
  TraceSceneInput,
  TraceRenderOptions,
  TraceProgress,
  TraceResult,
  TraceMemoryReport,
  TraceCamera,
  TraceTraversalMode,
} from "./trace-types.js";
import { TraceScene, normalizeTraceCamera } from "./trace-scene.js";
import {
  TraceGpu,
  requestTraceDevice,
  packTraceScene,
  traceUniform,
} from "./trace-gpu.js";
import { emptyReservoir, normalizeRestirConfig } from "./trace-sampling.js";
import type { TraceReservoir } from "./trace-sampling.js";
import {
  traceCpuSample,
  accumulateRecord,
  decodeTraceRecords,
} from "./trace-cpu.js";
import type { CpuTraceSettings } from "./trace-cpu.js";
import {
  integer,
  scalar,
  traceInvalid,
  traceLimit,
  cancelled,
  live,
} from "./trace-math.js";
/** Browser-owned, bounded progressive renderer. CPU is an explicit reference backend. */
interface CachedTrace {
  result: TraceResult;
  sum: Float32Array;
  reservoirs: TraceReservoir[];
  gpuReservoirs: ArrayBuffer | undefined;
  guiding: Float32Array | undefined;
}
export class PathTracer {
  readonly width: number;
  readonly height: number;
  readonly backend: "webgpu" | "cpu";
  readonly engine: "megakernel" | "wavefront";
  readonly memoryBudgetBytes: number;
  #settings: CpuTraceSettings;
  #scene: TraceScene;
  #gpu: TraceGpu | undefined;
  #sum: Float32Array;
  #reservoirs: TraceReservoir[];
  #samples = 0;
  #disposed = false;
  #busy = false;
  #cache = new Map<string, CachedTrace>();
  #cacheEnabled = false;
  #cacheCapacity = 8;
  #cacheHits = 0;
  #cacheMisses = 0;
  #peak = 0;
  #device: GPUDevice | undefined;
  #borrowed = false;
  private constructor(options: PathTracerOptions) {
    this.width = integer(options.width, "width", 1, 65536);
    this.height = integer(options.height, "height", 1, 65536);
    this.backend = options.backend ?? "webgpu";
    this.engine = options.engine ?? "megakernel";
    if (
      !["cpu", "webgpu"].includes(this.backend) ||
      !["megakernel", "wavefront"].includes(this.engine)
    )
      traceInvalid("unknown tracing backend or engine");
    const mode = options.traversalMode ?? "hybrid";
    if (!["hybrid", "mesh-only", "sdf-only"].includes(mode))
      traceInvalid("unknown traversal mode");
    this.memoryBudgetBytes = integer(
      options.memoryBudgetBytes ?? 512 * 1024 * 1024,
      "memoryBudgetBytes",
      1,
      16 * 1024 * 1024 * 1024,
    );
    const pixels = this.width * this.height;
    const workingBytes = pixels * (this.backend === "cpu" ? 488 : 1388);
    if (workingBytes > this.memoryBudgetBytes)
      traceLimit("trace working set", workingBytes, this.memoryBudgetBytes);
    if (
      options.guiding &&
      (options.guiding.width !== this.width ||
        options.guiding.height !== this.height)
    )
      traceInvalid("guiding dimensions must match tracer");
    this.#settings = {
      width: this.width,
      height: this.height,
      seed: integer(options.seed ?? 1, "seed", 0, 0xffffffff),
      maxBounces: integer(options.maxBounces ?? 4, "maxBounces", 1, 32),
      camera: normalizeTraceCamera(
        options.camera ?? { origin: [0, 0, 5], target: [0, 0, 0] },
      ),
      mode,
      clamp: scalar(options.luminanceClamp ?? 0, "luminanceClamp", 0),
      restir: options.restir
        ? normalizeRestirConfig(options.restir)
        : undefined,
      guiding: options.guiding,
    };
    this.#scene = new TraceScene();
    this.#sum = new Float32Array(pixels * 28);
    this.#reservoirs = Array.from({ length: pixels }, emptyReservoir);
    this.#admit();
  }
  static async create(
    options: PathTracerOptions,
    context: { device?: GPUDevice } = {},
  ): Promise<PathTracer> {
    const tracer = new PathTracer(options);
    try {
      if (tracer.backend === "webgpu") {
        tracer.#device =
          context.device ??
          (await requestTraceDevice(tracer.width * tracer.height * 192));
        tracer.#borrowed = !!context.device;
        await tracer.#rebuildGpu();
      }
      return tracer;
    } catch (error) {
      tracer.dispose();
      throw error;
    }
  }
  get size(): readonly [number, number] {
    return [this.width, this.height];
  }
  get samples(): number {
    return this.#samples;
  }
  supportsGpu(): boolean {
    return this.backend === "webgpu";
  }
  #guard(): void {
    live(this.#disposed);
  }
  #idle(): void {
    this.#guard();
    if (this.#busy)
      throw new Forge3DError(
        "INVALID_INPUT",
        "Another tracing request is active",
        { reason: "trace-busy" },
      );
  }
  #cpuBytes(): number {
    return (
      this.#sum.byteLength +
      this.width * this.height * 160 +
      (this.#scene.bvh?.stats.memoryUsageBytes ?? 0) +
      (this.#scene.sdf?.nodeCount() ?? 0) * 32 +
      (this.#scene.sdf?.primitiveCount() ?? 0) * 80 +
      this.#scene.materials.length * 48 +
      this.#scene.lights.length * 64 +
      (this.#gpu?.packed.bytes.byteLength ?? 0) +
      (this.#settings.guiding
        ? this.width * this.height * this.#settings.guiding.binsPerCell * 4
        : 0)
    );
  }
  #cacheBytes(): number {
    let bytes = 0;
    for (const entry of this.#cache.values()) {
      for (const value of Object.values(entry.result))
        if (ArrayBuffer.isView(value)) bytes += value.byteLength;
      bytes +=
        entry.sum.byteLength +
        (entry.gpuReservoirs?.byteLength ?? entry.reservoirs.length * 160) +
        (entry.guiding?.byteLength ?? 0) +
        128;
    }
    return bytes;
  }
  async #cacheKey(spp: number): Promise<string> {
    const packed = packTraceScene(
        this.#scene,
        this.#settings.guiding?.snapshot(),
      ),
      uniform = traceUniform(this.#scene, this.#settings, packed, 0),
      suffix = new TextEncoder().encode(
        JSON.stringify({ backend: this.backend, engine: this.engine, spp }),
      );
    this.#admit(
      2 * packed.bytes.byteLength + uniform.byteLength + suffix.length,
    );
    const bytes = new Uint8Array(
      packed.bytes.byteLength + uniform.byteLength + suffix.length,
    );
    bytes.set(new Uint8Array(packed.bytes));
    bytes.set(new Uint8Array(uniform), packed.bytes.byteLength);
    bytes.set(suffix, packed.bytes.byteLength + uniform.byteLength);
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  }
  #admit(extra = 0): void {
    const bytes =
      this.#cpuBytes() + (this.#gpu?.bytes ?? 0) + this.#cacheBytes() + extra;
    if (bytes > this.memoryBudgetBytes)
      traceLimit("trace working set", bytes, this.memoryBudgetBytes);
    this.#peak = Math.max(this.#peak, bytes);
  }
  async #rebuildGpu(): Promise<void> {
    if (this.backend !== "webgpu") return;
    this.#gpu?.dispose();
    this.#gpu = undefined;
    const gpu = await TraceGpu.create(
      this.#device!,
      this.#scene,
      this.#settings,
      this.memoryBudgetBytes -
        this.#cpuBytes() -
        this.#cacheBytes() -
        packTraceScene(this.#scene, this.#settings.guiding?.snapshot()).bytes
          .byteLength,
      false,
      this.engine,
    );
    if (this.#disposed) {
      gpu.dispose();
      this.#guard();
    }
    this.#gpu = gpu;
    this.#admit();
  }
  async setScene(input: TraceSceneInput): Promise<void> {
    this.#idle();
    this.#busy = true;
    const old = this.#scene;
    let replacement: TraceScene | undefined;
    try {
      replacement = new TraceScene(input, this.memoryBudgetBytes);
      const packed = packTraceScene(
        replacement,
        this.#settings.guiding?.snapshot(),
      );
      if (this.backend === "webgpu" && packed.counts[3]! > 256)
        traceLimit("SDF nodes", packed.counts[3]!, 256);
      this.#scene = replacement;
      this.#admit(packed.bytes.byteLength);
      await this.#rebuildGpu();
      this.#guard();
      old.dispose();
      this.#resetState();
    } catch (error) {
      replacement?.dispose();
      if (this.#disposed) {
        old.dispose();
        throw error;
      }
      const changed = this.#scene !== old;
      this.#scene = old;
      if (changed) await this.#rebuildGpu();
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  async setCamera(camera: TraceCamera): Promise<void> {
    this.#idle();
    this.#settings.camera = normalizeTraceCamera(camera);
    this.reset();
  }
  setTraversalMode(mode: TraceTraversalMode): void {
    this.#idle();
    if (!["hybrid", "mesh-only", "sdf-only"].includes(mode))
      traceInvalid("unknown traversal mode");
    this.#settings.mode = mode;
    this.reset();
  }
  reset(): void {
    this.#idle();
    this.#resetState();
  }
  #resetState(): void {
    this.#sum.fill(0);
    this.#samples = 0;
    this.#reservoirs = Array.from(
      { length: this.width * this.height },
      emptyReservoir,
    );
    this.#gpu?.reset();
  }
  enableSceneCache(enabled = true, capacity = 8): void {
    this.#idle();
    this.#cacheEnabled = enabled;
    this.#cacheCapacity = integer(capacity, "capacity", 1, 64);
    this.resetSceneCache();
  }
  resetSceneCache(): void {
    this.#idle();
    this.#cache.clear();
    this.#cacheHits = 0;
    this.#cacheMisses = 0;
  }
  cacheStats(): {
    hits: number;
    misses: number;
    entries: number;
    bytes: number;
  } {
    return {
      hits: this.#cacheHits,
      misses: this.#cacheMisses,
      entries: this.#cache.size,
      bytes: this.#cacheBytes(),
    };
  }
  async #sample(signal?: AbortSignal): Promise<TraceResult> {
    this.#guard();
    cancelled(signal);
    // Readback replacement and decoded AOVs overlap the previous accumulation.
    this.#admit(this.width * this.height * 216);
    if (this.#gpu) {
      const previous = this.#sum;
      const downloaded = await this.#gpu.sample(
        this.#samples,
        this.engine,
        signal,
      );
      this.#guard();
      this.#sum = downloaded;
      const grid = this.#settings.guiding;
      if (grid) {
        const bins = new Uint32Array(this.#sum.buffer);
        for (let p = 0; p < this.width * this.height; p++) {
          const bin = bins[p * 28 + 23]!;
          if (bin < grid.binsPerCell) {
            const at = p * 28 + 12,
              weight = Math.max(
                0,
                0.2126 * (this.#sum[at]! - previous[at]!) +
                  0.7152 * (this.#sum[at + 1]! - previous[at + 1]!) +
                  0.0722 * (this.#sum[at + 2]! - previous[at + 2]!),
              );
            grid.update(
              p % this.width,
              Math.floor(p / this.width),
              bin,
              weight,
            );
          }
        }
      }
    } else {
      const history = this.#reservoirs.slice(),
        next: TraceReservoir[] = [],
        updates: { pixel: number; bin: number; weight: number }[] = [];
      for (let pixel = 0; pixel < this.width * this.height; pixel++) {
        if (pixel % 256 === 0) {
          cancelled(signal);
          this.#guard();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          this.#guard();
          cancelled(signal);
        }
        const value = traceCpuSample(
          this.#scene,
          this.#settings,
          pixel,
          this.#samples,
          history,
        );
        accumulateRecord(this.#sum, value.record, pixel, this.#samples);
        next.push(value.reservoir);
        if (value.guidingBin !== undefined)
          updates.push({
            pixel,
            bin: value.guidingBin,
            weight: value.guidingWeight ?? 0,
          });
      }
      this.#reservoirs = next;
      for (const update of updates)
        this.#settings.guiding!.update(
          update.pixel % this.width,
          Math.floor(update.pixel / this.width),
          update.bin,
          update.weight,
        );
    }
    this.#samples++;
    this.#admit();
    return decodeTraceRecords(
      this.#sum,
      this.width,
      this.height,
      this.#samples,
    );
  }
  async *progressive(
    options: TraceRenderOptions & { updateEvery?: number } = {},
  ): AsyncGenerator<TraceProgress, void, unknown> {
    this.#idle();
    const spp = integer(options.spp ?? 1, "spp", 1, 1048576),
      updateEvery = integer(options.updateEvery ?? 1, "updateEvery", 1, spp);
    cancelled(options.signal);
    this.#busy = true;
    try {
      for (let i = 0; i < spp; i++) {
        const result = await this.#sample(options.signal);
        if ((i + 1) % updateEvery === 0 || i + 1 === spp)
          yield { samples: this.#samples, progress: (i + 1) / spp, result };
      }
    } catch (error) {
      this.#sum.fill(0);
      this.#samples = 0;
      try {
        this.#gpu?.reset();
      } catch {
        /* Lost devices are recovered explicitly. */
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  async render(options: TraceRenderOptions = {}): Promise<TraceResult> {
    this.#idle();
    this.#gpu?.checkAlive();
    const spp = integer(options.spp ?? 1, "spp", 1, 1048576);
    cancelled(options.signal);
    let key = "";
    if (this.#cacheEnabled) {
      this.#busy = true;
      try {
        key = await this.#cacheKey(spp);
      } finally {
        this.#busy = false;
      }
      this.#guard();
      this.#gpu?.checkAlive();
      cancelled(options.signal);
      const cached = this.#cache.get(key);
      if (cached) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        this.#cacheHits++;
        this.#sum = cached.sum.slice();
        this.#samples = cached.result.samples;
        this.#reservoirs = structuredClone(cached.reservoirs);
        if (cached.guiding) this.#settings.guiding!.restore(cached.guiding);
        if (this.#gpu) this.#gpu.restore(this.#sum, cached.gpuReservoirs!);
        return structuredClone(cached.result);
      }
      this.#cacheMisses++;
    }
    this.reset();
    let result: TraceResult | undefined;
    for await (const progress of this.progressive({
      ...options,
      spp,
      updateEvery: spp,
    }))
      result = progress.result;
    if (this.#cacheEnabled) {
      const bytes =
        Object.values(result!).reduce(
          (sum, v) => sum + (ArrayBuffer.isView(v) ? v.byteLength : 0),
          0,
        ) +
        this.#sum.byteLength +
        this.width * this.height * (this.#gpu ? 80 : 160) +
        (this.#settings.guiding
          ? this.width * this.height * this.#settings.guiding.binsPerCell * 4
          : 0) +
        128;
      while (
        this.#cache.size &&
        (this.#cache.size >= this.#cacheCapacity ||
          this.#cpuBytes() +
            (this.#gpu?.bytes ?? 0) +
            this.#cacheBytes() +
            bytes >
            this.memoryBudgetBytes)
      )
        this.#cache.delete(this.#cache.keys().next().value!);
      if (
        this.#cpuBytes() + (this.#gpu?.bytes ?? 0) + bytes <=
        this.memoryBudgetBytes
      ) {
        this.#busy = true;
        try {
          const gpuReservoirs = await this.#gpu?.exportReservoirs();
          this.#guard();
          cancelled(options.signal);
          this.#cache.set(key, {
            result: structuredClone(result!),
            sum: this.#sum.slice(),
            reservoirs: this.#gpu ? [] : structuredClone(this.#reservoirs),
            gpuReservoirs,
            guiding: this.#settings.guiding?.snapshot(),
          });
          this.#admit();
        } finally {
          this.#busy = false;
        }
      }
    }
    return result!;
  }
  async renderRgba(options: TraceRenderOptions = {}): Promise<Frame> {
    const result = await this.render(options),
      bytes = new Uint8Array(this.width * this.height * 4);
    for (let p = 0; p < this.width * this.height; p++) {
      for (let c = 0; c < 3; c++) {
        const x = result.color[p * 3 + c]!,
          linear = x / (1 + x),
          srgb =
            linear <= 0.0031308
              ? linear * 12.92
              : 1.055 * linear ** (1 / 2.4) - 0.055;
        bytes[p * 4 + c] = Math.round(Math.min(1, Math.max(0, srgb)) * 255);
      }
      bytes[p * 4 + 3] = 255;
    }
    return new Frame(this.width, this.height, bytes);
  }
  async renderHdr(options: TraceRenderOptions = {}): Promise<HdrFrame> {
    const r = await this.render(options),
      rgba = new Float32Array(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      rgba.set(r.color.subarray(i * 3, i * 3 + 3), i * 4);
      rgba[i * 4 + 3] = 1;
    }
    return new HdrFrame(this.width, this.height, rgba);
  }
  async recover(device?: GPUDevice): Promise<void> {
    this.#idle();
    if (this.backend === "cpu") return;
    this.#busy = true;
    try {
      this.#gpu?.dispose();
      this.#gpu = undefined;
      if (!this.#borrowed) this.#device?.destroy();
      const replacement =
        device ?? (await requestTraceDevice(this.width * this.height * 192));
      if (this.#disposed) {
        if (!device) replacement.destroy();
        this.#guard();
      }
      this.#device = replacement;
      this.#borrowed = !!device;
      await this.#rebuildGpu();
      this.#resetState();
    } finally {
      this.#busy = false;
    }
  }
  memoryReport(): TraceMemoryReport {
    return {
      cpuBytes: this.#disposed ? 0 : this.#cpuBytes(),
      gpuBytes: this.#disposed ? 0 : (this.#gpu?.bytes ?? 0),
      cacheBytes: this.#cacheBytes(),
      peakBytes: this.#peak,
      budgetBytes: this.memoryBudgetBytes,
      disposed: this.#disposed,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#gpu?.dispose();
    this.#gpu = undefined;
    if (!this.#borrowed) this.#device?.destroy();
    this.#scene.dispose();
    this.#sum = new Float32Array(0);
    this.#reservoirs = [];
    this.#cache.clear();
  }
}
export const createPathTracer = PathTracer.create;
