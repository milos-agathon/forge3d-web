import { Forge3DError } from "./index.js";
import { TRACE_PATH_WGSL } from "./trace-wgsl.js";
import { TraceScene } from "./trace-scene.js";
import type { CpuTraceSettings } from "./trace-cpu.js";
import { packGuidingWeights } from "./trace-sampling.js";
import {
  unit,
  sub,
  cross,
  integer,
  traceLimit,
  cancelled,
  live,
} from "./trace-math.js";
const U = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
export function packTraceScene(
  scene: TraceScene,
  guiding?: Float32Array,
  guidingBins = 8,
): {
  bytes: ArrayBuffer;
  offsets0: number[];
  offsets1: number[];
  counts: number[];
} {
  const chunks: ArrayBuffer[] = [];
  let words = 0;
  const push = (b: ArrayBuffer): number => {
    const offset = words;
    chunks.push(b);
    words += b.byteLength / 4;
    return offset;
  };
  const triangles = push(scene.bvh?.packTriangles() ?? new ArrayBuffer(64)),
    nodes = push(scene.bvh?.packNodes() ?? new ArrayBuffer(48)),
    indices = push(scene.bvh?.indices.slice().buffer ?? new ArrayBuffer(4));
  const sdf = scene.sdf?.pack(),
    primitives = push(sdf?.primitives ?? new ArrayBuffer(80)),
    csg = push(sdf?.nodes ?? new ArrayBuffer(32));
  const materials = new Float32Array(scene.materials.length * 12);
  scene.materials.forEach((m, i) => {
    materials.set(
      [
        ...m.albedo,
        m.metallic,
        ...m.emission,
        m.roughness,
        m.ior,
        m.ax,
        m.ay,
        0,
      ],
      i * 12,
    );
  });
  const matOffset = push(materials.buffer);
  const lights = new Float32Array(Math.max(1, scene.lights.length) * 16);
  scene.lights.forEach((l, i) =>
    lights.set(
      [
        ...l.position,
        l.intensity,
        ...l.color,
        l.weight,
        ...l.direction,
        l.type === "point" ? 0 : l.type === "directional" ? 1 : 2,
        ...l.normal,
        l.radius,
      ],
      i * 16,
    ),
  );
  const lightOffset = push(lights.buffer),
    guidingOffset = push(
      guiding
        ? packGuidingWeights(guiding, guidingBins).buffer
        : new ArrayBuffer(4),
    );
  const bytes = new ArrayBuffer(words * 4),
    target = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    target.set(new Uint8Array(chunk), at);
    at += chunk.byteLength;
  }
  return {
    bytes,
    offsets0: [triangles, nodes, indices, primitives],
    offsets1: [csg, matOffset, lightOffset, guidingOffset],
    counts: [
      scene.bvh?.nodes.length ?? 0,
      scene.bvh?.triangles.length ?? 0,
      scene.sdf?.primitiveCount() ?? 0,
      scene.sdf?.nodeCount() ?? 0,
    ],
  };
}
export function traceUniform(
  scene: TraceScene,
  s: CpuTraceSettings,
  packed: ReturnType<typeof packTraceScene>,
  sample: number,
): ArrayBuffer {
  const data = new ArrayBuffer(304),
    u = new Uint32Array(data),
    v = new Float32Array(data),
    forward = unit(sub(s.camera.target, s.camera.origin)),
    right = unit(cross(forward, s.camera.up)),
    up = cross(right, forward);
  u.set([s.width, s.height, sample, s.maxBounces], 0);
  u.set(packed.counts, 4);
  u.set(
    [
      s.mode === "hybrid" ? 0 : s.mode === "sdf-only" ? 1 : 2,
      s.seed,
      scene.lights.length,
      s.restir?.initialCandidates ?? 0,
    ],
    8,
  );
  u.set(packed.offsets0, 12);
  u.set(packed.offsets1, 16);
  v.set(s.camera.origin, 20);
  v.set(forward, 24);
  v.set(right, 28);
  v.set(up, 32);
  v.set(scene.environment, 36);
  // extra.w must have zero bits: WGSL contribution barriers XOR this word.
  v.set(
    [Math.tan((s.camera.fovY * Math.PI) / 360), s.width / s.height, s.clamp, 0],
    40,
  );
  if (scene.medium) {
    v.set(scene.medium.bounds.min, 44);
    v.set(scene.medium.bounds.max, 48);
    v.set([...scene.medium.sigmaA, scene.medium.g ?? 0], 52);
    v.set([...scene.medium.sigmaS, 1], 56);
  }
  u.set(
    [
      s.restir?.temporalNeighbors ?? 0,
      s.restir?.spatialNeighbors ?? 0,
      s.restir?.maxTemporalAge ?? 0,
      s.guiding?.binsPerCell ?? 0,
    ],
    60,
  );
  v.set(
    [
      s.restir?.depthThreshold ?? 0,
      s.restir?.normalThreshold ?? 0,
      s.restir?.spatialRadius ?? 0,
      s.restir?.biasCorrection ? 1 : 0,
    ],
    64,
  );
  const bounds = scene.sdf?.getBounds();
  if (bounds) {
    v.set([...bounds.min, 1], 68);
    v.set(bounds.max, 72);
  }
  return data;
}
export async function requestTraceDevice(
  minStorageBytes = 128 * 1024 * 1024,
): Promise<GPUDevice> {
  if (typeof navigator === "undefined" || !navigator.gpu)
    throw new Forge3DError(
      "WEBGPU_UNAVAILABLE",
      "WebGPU compute is unavailable",
      { reason: "trace-compute-unavailable" },
    );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter)
    throw new Forge3DError(
      "WEBGPU_ADAPTER_UNAVAILABLE",
      "Tracing adapter unavailable",
    );
  if (adapter.limits.maxStorageBuffersPerShaderStage < 8)
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "Tracing requires eight storage buffers",
      {
        reason: "trace-storage-bindings",
        required: 8,
        available: adapter.limits.maxStorageBuffersPerShaderStage,
      },
    );
  if (minStorageBytes > adapter.limits.maxStorageBufferBindingSize)
    traceLimit(
      "maxStorageBufferBindingSize",
      minStorageBytes,
      adapter.limits.maxStorageBufferBindingSize,
    );
  try {
    return await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.max(
          128 * 1024 * 1024,
          minStorageBytes,
        ),
        maxBufferSize: Math.max(256 * 1024 * 1024, minStorageBytes),
      },
    });
  } catch (error) {
    throw new Forge3DError(
      "DEVICE_REQUEST_FAILED",
      "Tracing device request failed",
      error,
    );
  }
}
const compiledTracePipelines = new WeakMap<
  GPUDevice,
  Map<
    string,
    Promise<{
      layout: GPUBindGroupLayout;
      pipelines: Map<string, GPUComputePipeline>;
    }>
  >
>();
export class TraceGpu {
  #buffers: GPUBuffer[] = [];
  #pipelines = new Map<string, GPUComputePipeline>();
  #groups = new Map<string, GPUBindGroup>();
  #disposed = false;
  #lost = false;
  #uniform: GPUBuffer;
  #scene: GPUBuffer;
  #paths: GPUBuffer[];
  #output: GPUBuffer;
  #work: GPUBuffer;
  #reservoirs: GPUBuffer;
  #history: GPUBuffer;
  #readback: GPUBuffer;
  #pending: GPUBuffer;
  readonly packed: ReturnType<typeof packTraceScene>;
  readonly bytes: number;
  private constructor(
    readonly device: GPUDevice,
    readonly source: TraceScene,
    readonly settings: CpuTraceSettings,
    readonly budget: number,
    readonly ownsDevice: boolean,
  ) {
    if (device.limits.maxStorageBuffersPerShaderStage < 8)
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Tracing requires eight storage buffers",
        {
          reason: "trace-storage-bindings",
          required: 8,
          available: device.limits.maxStorageBuffersPerShaderStage,
        },
      );
    this.packed = packTraceScene(
      source,
      settings.guiding?.snapshot(),
      settings.guiding?.binsPerCell,
    );
    const n = settings.width * settings.height,
      blocks = Math.ceil(n / 256);
    if (this.packed.counts[3]! > 256)
      traceLimit("SDF nodes", this.packed.counts[3]!, 256);
    if (n > device.limits.maxComputeWorkgroupsPerDimension * 64)
      traceLimit(
        "trace dispatch pixels",
        n,
        device.limits.maxComputeWorkgroupsPerDimension * 64,
      );
    const sizes = [
      304,
      this.packed.bytes.byteLength,
      n * 192,
      n * 192,
      n * 112,
      (4 + n + blocks) * 4,
      n * 80,
      n * 80,
      n * 112,
      n * 128,
    ];
    this.bytes = sizes.reduce((a, b) => a + b, 0);
    if (this.bytes > budget) traceLimit("trace GPU bytes", this.bytes, budget);
    for (const size of sizes) {
      if (size > device.limits.maxBufferSize)
        traceLimit("maxBufferSize", size, device.limits.maxBufferSize);
      if (size > device.limits.maxStorageBufferBindingSize && size !== 304)
        traceLimit(
          "maxStorageBufferBindingSize",
          size,
          device.limits.maxStorageBufferBindingSize,
        );
    }
    const create = (size: number, usage: number): GPUBuffer => {
      const b = device.createBuffer({
        size: Math.max(4, size),
        usage,
        label: "forge3d W17 trace",
      });
      this.#buffers.push(b);
      return b;
    };
    this.#uniform = create(304, U.UNIFORM | U.COPY_DST);
    this.#scene = create(sizes[1]!, U.STORAGE | U.COPY_DST);
    this.#paths = [create(n * 192, U.STORAGE), create(n * 192, U.STORAGE)];
    this.#output = create(n * 112, U.STORAGE | U.COPY_SRC | U.COPY_DST);
    this.#work = create(sizes[5]!, U.STORAGE | U.COPY_DST);
    this.#reservoirs = create(n * 80, U.STORAGE | U.COPY_SRC | U.COPY_DST);
    this.#history = create(n * 80, U.STORAGE | U.COPY_DST);
    this.#readback = create(n * 112, U.MAP_READ | U.COPY_DST);
    this.#pending = create(n * 128, U.STORAGE);
    device.queue.writeBuffer(this.#scene, 0, this.packed.bytes);
    const weak = new WeakRef(this);
    device.lost.then(() => {
      const gpu = weak.deref();
      if (gpu) gpu.#lost = true;
    });
  }
  static async create(
    device: GPUDevice,
    scene: TraceScene,
    settings: CpuTraceSettings,
    budget: number,
    ownsDevice = false,
    engine: "megakernel" | "wavefront" = "megakernel",
  ): Promise<TraceGpu> {
    let gpu: TraceGpu | undefined;
    device.pushErrorScope("validation");
    try {
      gpu = new TraceGpu(device, scene, settings, budget, ownsDevice);
      let cache = compiledTracePipelines.get(device);
      if (!cache) {
        cache = new Map();
        compiledTracePipelines.set(device, cache);
      }
      const sdfNodes = gpu.packed.counts[3]!,
        features = {
          sdf: sdfNodes > 0,
          lights: scene.lights.length > 0,
          medium: !!scene.medium,
          guiding: !!settings.guiding,
          restir: !!settings.restir,
        };
      const key = JSON.stringify([engine, sdfNodes, features]);
      let compilation = cache.get(key);
      if (!compilation) {
        compilation = (async () => {
          let code = TRACE_PATH_WGSL.replace(
            "distances:array<f32,256>",
            `distances:array<f32,${Math.max(1, sdfNodes)}>`,
          ).replace(
            "materials:array<u32,256>",
            `materials:array<u32,${Math.max(1, sdfNodes)}>`,
          );
          if (!features.sdf)
            code = code
              .replace("if(params.counts.w==0u||params.mode.x==2u)", "if(true)")
              .replace("if(params.counts.w==0u)", "if(true)");
          if (!features.lights)
            code = code.replace("if(params.mode.z>0u)", "if(false)");
          if (!features.medium)
            code = code.replace("if(params.mediumS.w>0.5)", "if(false)");
          if (!features.guiding)
            code = code.replace("if(params.reuse.w>0u)", "if(false)");
          code = code.replace("b<params.dims.w", "b<min(params.dims.w,32u)");
          const module = device.createShaderModule({
            code,
            label: "forge3d W17 path tracing",
          });
          const info = await module.getCompilationInfo();
          const errors = info.messages.filter((m) => m.type === "error");
          if (errors.length)
            throw new Forge3DError(
              "SHADER_COMPILATION_FAILED",
              errors.map((e) => e.message).join("\n"),
            );
          const layout = device.createBindGroupLayout({
            entries: Array.from({ length: 9 }, (_, binding) => ({
              binding,
              visibility: 4,
              buffer: {
                type:
                  binding === 0
                    ? "uniform"
                    : binding === 1 || binding === 7
                      ? "read-only-storage"
                      : "storage",
              },
            })),
          });
          const pipelineLayout = device.createPipelineLayout({
              bindGroupLayouts: [layout],
            }),
            pipelines = new Map<string, GPUComputePipeline>();
          const entries =
            engine === "megakernel"
              ? ["megakernel"]
              : [
                  "raygen",
                  "intersect_queue",
                  "shade_queue",
                  "shadow_queue",
                  "compact_count",
                  "compact_prefix",
                  "compact_scatter",
                  "compact_commit",
                ];
          for (const entryPoint of entries)
            pipelines.set(
              entryPoint,
              await device.createComputePipelineAsync({
                layout: pipelineLayout,
                compute: { module, entryPoint },
              }),
            );
          return { layout, pipelines };
        })();
        cache.set(key, compilation);
        compilation.catch(() => cache!.delete(key));
      }
      const { layout, pipelines } = await compilation;
      gpu.checkAlive();
      gpu.#pipelines = new Map(pipelines);
      for (let swap = 0; swap < 2; swap++) {
        const buffers = [
          gpu.#uniform,
          gpu.#scene,
          gpu.#paths[swap]!,
          gpu.#paths[1 - swap]!,
          gpu.#output,
          gpu.#work,
          gpu.#reservoirs,
          gpu.#history,
          gpu.#pending,
        ];
        gpu.#groups.set(
          String(swap),
          device.createBindGroup({
            layout,
            entries: buffers.map((buffer, binding) => ({
              binding,
              resource: { buffer },
            })),
          }),
        );
      }
      const error = await device.popErrorScope();
      if (error)
        throw new Forge3DError("SHADER_COMPILATION_FAILED", error.message);
      gpu.checkAlive();
      return gpu;
    } catch (error) {
      const lost = gpu ? gpu.#lost : false;
      gpu?.dispose();
      if (!gpu && ownsDevice) device.destroy();
      await device.popErrorScope().catch(() => null);
      if (lost)
        throw new Forge3DError(
          "DEVICE_LOST",
          "Tracing device lost during pipeline creation",
        );
      throw error;
    }
  }
  #guard(): void {
    live(this.#disposed);
    if (this.#lost)
      throw new Forge3DError("DEVICE_LOST", "Tracing device lost");
  }
  /** Retained GPU allocations, independent of the admission estimate. */
  get allocatedBytes(): number {
    return this.#buffers.reduce((sum, buffer) => sum + buffer.size, 0);
  }
  checkAlive(): void {
    this.#guard();
  }
  async exportReservoirs(): Promise<ArrayBuffer> {
    this.#guard();
    const bytes = this.settings.width * this.settings.height * 80,
      buffer = this.device.createBuffer({
        size: bytes,
        usage: U.MAP_READ | U.COPY_DST,
      });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.#reservoirs, 0, buffer, 0, bytes);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1);
      this.#guard();
      return buffer.getMappedRange().slice(0);
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  }
  restore(sum: Float32Array, reservoirs: ArrayBuffer): void {
    this.#guard();
    this.device.queue.writeBuffer(
      this.#output,
      0,
      sum.buffer as ArrayBuffer,
      sum.byteOffset,
      sum.byteLength,
    );
    this.device.queue.writeBuffer(this.#reservoirs, 0, reservoirs);
  }
  reset(): void {
    this.#guard();
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.#output);
    encoder.clearBuffer(this.#reservoirs);
    encoder.clearBuffer(this.#history);
    this.device.queue.submit([encoder.finish()]);
  }
  async sample(
    sample: number,
    engine: "megakernel" | "wavefront",
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    this.#guard();
    cancelled(signal);
    if (this.settings.guiding) {
      const weights = packGuidingWeights(
        this.settings.guiding.snapshot(),
        this.settings.guiding.binsPerCell,
      );
      this.device.queue.writeBuffer(
        this.#scene,
        this.packed.offsets1[3]! * 4,
        weights.buffer,
      );
    }
    const n = this.settings.width * this.settings.height;
    this.device.queue.writeBuffer(
      this.#uniform,
      0,
      traceUniform(this.source, this.settings, this.packed, sample),
    );
    this.device.queue.writeBuffer(this.#work, 0, new Uint32Array([n, 0, 0, 0]));
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.#reservoirs, 0, this.#history, 0, n * 80);
    const dispatch = (entry: string, count: number, swap = 0): void => {
      const pass = encoder.beginComputePass({ label: entry });
      pass.setPipeline(this.#pipelines.get(entry)!);
      pass.setBindGroup(0, this.#groups.get(String(swap))!);
      pass.dispatchWorkgroups(Math.max(1, count));
      pass.end();
    };
    if (engine === "megakernel") dispatch("megakernel", Math.ceil(n / 64));
    else {
      dispatch("raygen", Math.ceil(n / 64));
      for (let bounce = 0; bounce < this.settings.maxBounces; bounce++) {
        const swap = bounce % 2;
        dispatch("intersect_queue", Math.ceil(n / 64), swap);
        dispatch("shade_queue", Math.ceil(n / 64), swap);
        dispatch("shadow_queue", Math.ceil(n / 64), swap);
        dispatch("compact_count", Math.ceil(n / 256), swap);
        dispatch("compact_prefix", 1, swap);
        dispatch("compact_scatter", Math.ceil(n / 64), swap);
        dispatch("compact_commit", 1, swap);
      }
    }
    encoder.copyBufferToBuffer(this.#output, 0, this.#readback, 0, n * 112);
    this.device.queue.submit([encoder.finish()]);
    try {
      await this.#readback.mapAsync(1);
      this.#guard();
      cancelled(signal);
      return new Float32Array(this.#readback.getMappedRange().slice(0));
    } catch (error) {
      this.#guard();
      throw error;
    } finally {
      this.#readback.unmap();
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const buffer of this.#buffers) buffer.destroy();
    this.#buffers = [];
    this.#groups.clear();
    this.#pipelines.clear();
    if (this.ownsDevice) this.device.destroy();
  }
}
