import { TraceCheckpoints } from './trace-checkpoints.js';
import { TraceAccumulation } from './trace-accumulation.js';
import { Forge3DError } from "./runtime-failure.js";
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
} from "./trace-gpu.js";
import { emptyReservoir, normalizeRestirConfig } from "./trace-sampling.js";
import type { TraceReservoir } from "./trace-sampling.js";
import {
  traceCpuSample,
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
export class PathTracer {
  readonly width: number;
  readonly height: number;
  readonly backend: "webgpu" | "cpu";
  readonly engine: "megakernel" | "wavefront";
  readonly memoryBudgetBytes: number;
  #settings: CpuTraceSettings;
  #scene: TraceScene | undefined;
  #gpu: TraceGpu | undefined;
  #accumulation: TraceAccumulation;
  #reservoirs: TraceReservoir[];
  #disposed = false;
  #busy = false;
  #cache = new TraceCheckpoints();
  #cacheEnabled = false;
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
    this.#accumulation = new TraceAccumulation(this.width, this.height);
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
    return this.#accumulation.samples;
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
  #checkBackend(): void {
    if (this.backend === "webgpu") {
      if (!this.#gpu)
        throw new Forge3DError(
          "DEVICE_LOST",
          "Tracing GPU unavailable; recover before rendering",
          { reason: "trace-recovery-required" },
        );
      this.#gpu.checkAlive();
    }
  }
  #cpuBytes(): number {
    return (
      this.#accumulation.records.byteLength +
      this.#reservoirs.length * 160 +
      (this.#scene?.bvh?.stats.memoryUsageBytes ?? 0) +
      (this.#scene?.sdf?.nodeCount() ?? 0) * 32 +
      (this.#scene?.sdf?.primitiveCount() ?? 0) * 80 +
      (this.#scene?.materials.length ?? 0) * 48 +
      (this.#scene?.lights.length ?? 0) * 64 +
      (this.#gpu?.packed.bytes.byteLength ?? 0) +
      (this.#settings.guiding
        ? this.width * this.height * this.#settings.guiding.binsPerCell * 4
        : 0)
    );
  }
  #admit(extra = 0): void {
    const bytes =
      this.#cpuBytes() + (this.#gpu?.bytes ?? 0) + this.#cache.bytes + extra;
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
      this.#scene!,
      this.#settings,
      this.memoryBudgetBytes -
        this.#cpuBytes() -
        this.#cache.bytes -
        packTraceScene(
          this.#scene!,
          this.#settings.guiding?.snapshot(),
          this.#settings.guiding?.binsPerCell,
        ).bytes.byteLength,
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
        this.#settings.guiding?.binsPerCell,
      );
      if (this.backend === "webgpu" && packed.counts[3]! > 256)
        traceLimit("SDF nodes", packed.counts[3]!, 256);
      this.#scene = replacement;
      this.#admit(packed.bytes.byteLength);
      await this.#rebuildGpu();
      this.#guard();
      old!.dispose();
      this.#resetState();
    } catch (error) {
      replacement?.dispose();
      if (this.#disposed) {
        old!.dispose();
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
    this.#accumulation.reset();
    this.#reservoirs = Array.from(
      { length: this.width * this.height },
      emptyReservoir,
    );
    this.#gpu?.reset();
  }
  enableSceneCache(enabled = true, capacity = 8): void {
    this.#idle();
    this.#cacheEnabled = enabled;
    this.#cache.capacity = integer(capacity, "capacity", 1, 64);
    this.resetSceneCache();
  }
  resetSceneCache(): void {
    this.#idle();
    this.#cache.clear();
  }
  cacheStats(): {
    hits: number;
    misses: number;
    entries: number;
    bytes: number;
  } {
    return this.#cache.stats();
  }
  async #sample(signal?: AbortSignal): Promise<void> {
    this.#guard();
    cancelled(signal);
    this.#checkBackend();
    // Readback replacement and decoded AOVs overlap the previous accumulation.
    this.#admit(
      this.width *
        this.height *
        (216 + (this.#settings.guiding?.binsPerCell ?? 0) * 16),
    );
    if (this.#gpu) {
      const downloaded = await this.#gpu.sample(
        this.#accumulation.samples,
        this.engine,
        signal,
      );
      this.#guard();
      this.#accumulation.acceptGpu(downloaded);
      const grid = this.#settings.guiding;
      if (grid) {
        const bins = new Uint32Array(this.#accumulation.records.buffer);
        for (let p = 0; p < this.width * this.height; p++) {
          const bin = bins[p * 28 + 23]!;
          if (bin < grid.binsPerCell) {
            const weight = this.#accumulation.records[p * 28 + 3]!;
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
          this.#scene!,
          this.#settings,
          pixel,
          this.#accumulation.samples,
          history,
        );
        this.#accumulation.add(value.record, pixel);
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
    this.#accumulation.complete();
    this.#admit();

  }
  async *#progressiveLocked(
    options: TraceRenderOptions & { updateEvery?: number } = {},
  ): AsyncGenerator<TraceProgress, void, unknown> {
    const spp = integer(options.spp ?? 1, "spp", 1, 1048576),
      updateEvery = integer(options.updateEvery ?? 1, "updateEvery", 1, spp);
    cancelled(options.signal);
    try {
      for (let i = 0; i < spp; i++) {
        await this.#sample(options.signal);
        const result = this.#accumulation.resolveUpdate(i + 1, spp, updateEvery);
        if (result)
          yield { samples: this.#accumulation.samples, progress: (i + 1) / spp, result };
      }
    } catch (error) {
      this.#accumulation.reset();
      try {
        this.#gpu?.reset();
      } catch {
        /* Lost devices are recovered explicitly. */
      }
      throw error;
    }
  }
  async *progressive(
    options: TraceRenderOptions & { updateEvery?: number } = {},
  ): AsyncGenerator<TraceProgress, void, unknown> {
    this.#idle();
    this.#checkBackend();
    this.#busy = true;
    try {
      yield* this.#progressiveLocked(options);
    } finally {
      this.#busy = false;
    }
  }
  #checkpointState() {
    return {accumulation:this.#accumulation,reservoirs:this.#reservoirs,guiding:this.#settings.guiding,gpu:this.#gpu};
  }
  async render(options: TraceRenderOptions = {}): Promise<TraceResult> {
    this.#idle();
    this.#checkBackend();
    const spp = integer(options.spp ?? 1, "spp", 1, 1048576);
    cancelled(options.signal);
    this.#busy = true;
    try {
      let key = "";
      if (this.#cacheEnabled) {
        key = await this.#cache.key(this.#scene!,this.#settings,this.backend,this.engine,spp,bytes=>this.#admit(bytes));
        this.#guard();
        this.#checkBackend();
        cancelled(options.signal);
        const cached = this.#cache.restore(key,this.#checkpointState());
        if(cached){this.#reservoirs=cached.reservoirs;return cached.result;}
      }
      this.#resetState();
      let result: TraceResult | undefined;
      for await (const progress of this.#progressiveLocked({
        ...options,
        spp,
        updateEvery: spp,
      }))
        result = progress.result;
      if(this.#cacheEnabled) {
        await this.#cache.retain(key,result!,this.#checkpointState(),this.memoryBudgetBytes-this.#cpuBytes()-(this.#gpu?.bytes??0),()=>{this.#guard();cancelled(options.signal);});
        this.#admit();
      }
      return result!;
    } finally {
      this.#busy = false;
    }
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
      cpuBytes: this.#cpuBytes(),
      gpuBytes: this.#gpu?.allocatedBytes ?? 0,
      cacheBytes: this.#cache.bytes,
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
    this.#scene?.dispose();
    this.#scene = undefined;
    this.#settings.guiding = undefined;
    this.#accumulation.dispose();
    this.#reservoirs = [];
    this.#cache.clear();
  }
}
export const createPathTracer = PathTracer.create;
