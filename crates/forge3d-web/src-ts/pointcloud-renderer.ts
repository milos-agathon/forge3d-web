import { Forge3DError } from "./index.js";
import { PointCloudLayer, normalizePointStyle } from "./pointcloud-layer.js";
import type { PointCloudLayerSnapshot } from "./pointcloud-layer.js";
import { PointBuffer } from "./pointcloud-buffer.js";
import type { PointView, PointVec3 } from "./pointcloud-types.js";
import {
  pointLive,
  pointLimit,
  pointInteger,
  pointView,
  pointError,
  pointCancelled,
} from "./pointcloud-common.js";
export interface PointRendererOptions {
  memoryBudgetBytes?: number;
  clearColor?: readonly [number, number, number, number];
  powerPreference?: "low-power" | "high-performance";
  onDeviceLost?: (reason: string) => void;
}
export interface PointPickResult {
  id: number;
  layerName: string;
  nodeKey: string;
  pointIndex: number;
  position: PointVec3;
  color: readonly number[];
}
interface NodeGpu {
  source: PointBuffer;
  retained: PointBuffer;
  buffer: GPUBuffer;
  bytes: number;
  baseId: number;
}
interface LayerGpu {
  uniform: GPUBuffer;
  group: GPUBindGroup;
  nodes: Map<string, NodeGpu>;
  bytes: number;
}
// WebGPU's stable flag values; TypeScript 6 DOM declares interfaces but omits these globals.
const GPUBufferUsage = { MAP_READ: 1, COPY_DST: 8, VERTEX: 32, UNIFORM: 64 };
const GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, RENDER_ATTACHMENT: 16 };
const GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
const GPUMapMode = { READ: 1 };
const SHADER = `
struct Params {vp:mat4x4<f32>, viewport:vec4<f32>, tint:vec4<f32>, mode:vec4<f32>};
@group(0) @binding(0) var<uniform> params:Params;
struct VOut {@builtin(position) clip:vec4<f32>,@location(0) uv:vec2<f32>,@location(1) color:vec4<f32>,@location(2) @interpolate(flat) id:u32};
@vertex fn vs(@builtin(vertex_index) vertex:u32,@location(0) position:vec3<f32>,@location(1) color:vec4<f32>,@location(2) id:u32,@location(3) intensity:f32,@location(4) elevation:f32,@location(5) classification:u32)->VOut {
  let corners=array<vec2<f32>,6>(vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
  var out:VOut;let center=params.vp*vec4(position,1.);let corner=corners[vertex];
  out.clip=center+vec4(corner*params.viewport.z/params.viewport.xy*center.w,0.,0.);out.uv=corner;out.id=id;
  var rgb=color.rgb;
  if(params.mode.x==1.){let t=clamp(elevation,0.,1.);rgb=vec3(t,1.-abs(t*2.-1.),1.-t);}
  if(params.mode.x==2.){rgb=vec3(intensity);}
  if(params.mode.x==3.){let k=f32(classification);rgb=fract(vec3(k*0.618+0.2,k*0.381+0.4,k*0.173+0.6));}
  out.color=vec4(rgb,color.a)*params.tint;return out;
}
struct FOut {@location(0) color:vec4<f32>,@location(1) id:u32};
@fragment fn fs(in:VOut)->FOut {if(params.viewport.w>0.5&&dot(in.uv,in.uv)>1.){discard;}if(in.color.a<=0.){discard;}var out:FOut;out.color=in.color;out.id=in.id;return out;}
`;
/** Instanced billboards: 32 bytes/point, six generated vertices, depth-aligned integer picking. */
export class PointCloudRenderer {
  readonly memoryBudgetBytes: number;
  #device: GPUDevice;
  #context: GPUCanvasContext;
  #format: GPUTextureFormat;
  #pipeline: GPURenderPipeline;
  #layout: GPUBindGroupLayout;
  #layers = new Map<PointCloudLayer, LayerGpu>();
  #ids = new Map<
    PointCloudLayer,
    Map<string, { base: number; count: number }>
  >();
  #nextId = 1;
  #color: GPUTexture | undefined;
  #id: GPUTexture | undefined;
  #depth: GPUTexture | undefined;
  #width = 0;
  #height = 0;
  #disposed = false;
  #lost = false;
  #generation = 0;
  #frames = 0;
  #peakBytes = 0;
  #bufferCreations = 0;
  #durations: number[] = [];
  #view: PointView | undefined;
  #readbacks = new Set<GPUBuffer>();
  #retainedLayers: readonly PointCloudLayer[] = [];
  #recoverySnapshots:
    | { layer: PointCloudLayer; snapshot: PointCloudLayerSnapshot }[]
    | undefined;
  #recoverySources = new Map<PointCloudLayer, Map<string, PointBuffer>>();
  private constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    device: GPUDevice,
    readonly options: PointRendererOptions,
  ) {
    this.memoryBudgetBytes = options.memoryBudgetBytes ?? 256 * 1024 * 1024;
    pointInteger(this.memoryBudgetBytes, "memoryBudgetBytes", 1);
    this.#device = device;
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context)
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "WebGPU canvas unavailable",
      );
    this.#context = context;
    this.#format = navigator.gpu.getPreferredCanvasFormat();
    this.#layout = this.#createLayout();
    this.#pipeline = this.#createPipeline();
    this.#configure();
    this.#watchLoss();
  }
  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: PointRendererOptions = {},
  ): Promise<PointCloudRenderer> {
    if (!navigator.gpu)
      throw new Forge3DError("WEBGPU_UNAVAILABLE", "WebGPU is unavailable");
    const adapter = await navigator.gpu.requestAdapter(
      options.powerPreference
        ? { powerPreference: options.powerPreference }
        : {},
    );
    if (!adapter)
      throw new Forge3DError(
        "WEBGPU_ADAPTER_UNAVAILABLE",
        "WebGPU adapter unavailable",
      );
    const device = await adapter.requestDevice();
    try {
      return new PointCloudRenderer(canvas, device, options);
    } catch (e) {
      device.destroy();
      throw e;
    }
  }
  #guard(): void {
    pointLive(this.#disposed);
    if (this.#lost)
      throw new Forge3DError("DEVICE_LOST", "Point renderer device lost");
  }
  #configure(): void {
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "premultiplied",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
  }
  #watchLoss(): void {
    const generation = this.#generation;
    void this.#device.lost.then((info) => {
      if (this.#disposed || generation !== this.#generation) return;
      this.#lost = true;
      this.options.onDeviceLost?.(info.message);
    });
  }
  #createLayout(): GPUBindGroupLayout {
    return this.#device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
  }
  #createPipeline(): GPURenderPipeline {
    const module = this.#device.createShaderModule({ code: SHADER });
    return this.#device.createRenderPipeline({
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#layout],
      }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 32,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "unorm8x4" },
              { shaderLocation: 2, offset: 16, format: "uint32" },
              { shaderLocation: 3, offset: 20, format: "float32" },
              { shaderLocation: 4, offset: 24, format: "float32" },
              { shaderLocation: 5, offset: 28, format: "uint32" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: this.#format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
          { format: "r32uint" },
        ],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });
  }
  #bytes(): number {
    return (
      this.#width * this.#height * 12 +
      Array.from(this.#layers.values()).reduce((n, l) => n + l.bytes, 0) +
      Array.from(this.#readbacks).reduce((n, b) => n + b.size, 0)
    );
  }
  #admit(additional: number): void {
    pointLimit(this.#bytes() + additional, this.memoryBudgetBytes);
    this.#peakBytes = Math.max(this.#peakBytes, this.#bytes() + additional);
  }
  resize(width: number, height: number): void {
    this.#guard();
    pointInteger(width, "width", 1, this.#device.limits.maxTextureDimension2D);
    pointInteger(
      height,
      "height",
      1,
      this.#device.limits.maxTextureDimension2D,
    );
    if (width === this.#width && height === this.#height) return;
    this.#admit(width * height * 12);
    const create = (format: GPUTextureFormat) =>
      this.#device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    const color = create(this.#format),
      id = create("r32uint"),
      depth = create("depth32float");
    this.#color?.destroy();
    this.#id?.destroy();
    this.#depth?.destroy();
    this.#color = color;
    this.#id = id;
    this.#depth = depth;
    this.#width = width;
    this.#height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }
  setLayers(layers: readonly PointCloudLayer[]): void {
    this.#install(
      layers.map((layer) => ({ layer, snapshot: layer.snapshot() })),
    );
  }
  #install(
    snapshots: { layer: PointCloudLayer; snapshot: PointCloudLayerSnapshot }[],
  ): void {
    this.#guard();
    const layers = snapshots.map((s) => s.layer);
    if (new Set(layers).size !== layers.length)
      pointError("Duplicate point layer");
    let additional = 0;
    for (const { layer, snapshot } of snapshots) {
      const old = this.#layers.get(layer);
      if (!old) additional += 112;
      for (const { key, buffer } of snapshot.nodes)
        if (old?.nodes.get(key)?.source !== buffer) {
          pointLimit(buffer.pointCount * 32, this.#device.limits.maxBufferSize);
          additional += Math.max(32, buffer.pointCount * 32);
        }
    }
    this.#admit(additional);
    const staged = new Map<PointCloudLayer, LayerGpu>(),
      created: GPUBuffer[] = [],
      retained: PointBuffer[] = [];
    try {
      for (const { layer, snapshot } of snapshots) {
        const old = this.#layers.get(layer),
          uniform =
            old?.uniform ??
            this.#device.createBuffer({
              size: 112,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        if (!old) created.push(uniform);
        const group =
            old?.group ??
            this.#device.createBindGroup({
              layout: this.#layout,
              entries: [{ binding: 0, resource: { buffer: uniform } }],
            }),
          nodes = new Map<string, NodeGpu>();
        let bytes = 112;
        let ids = this.#ids.get(layer);
        if (!ids) {
          ids = new Map();
          this.#ids.set(layer, ids);
        }
        for (const { key, buffer: source } of snapshot.nodes) {
          let gpu = old?.nodes.get(key);
          if (gpu?.source !== source) {
            let id = ids.get(key);
            if (!id) {
              if (this.#nextId + source.pointCount > 0xffffffff)
                pointError("Point ID namespace exhausted");
              id = { base: this.#nextId, count: source.pointCount };
              this.#nextId += source.pointCount;
              ids.set(key, id);
            }
            if (id.count !== source.pointCount)
              pointError("Immutable point node count changed");
            const raw = new ArrayBuffer(Math.max(32, source.pointCount * 32)),
              v = new DataView(raw),
              range = Math.max(
                0.001,
                layer.dataset.bounds.max[2] - layer.dataset.bounds.min[2],
              );
            // Copy each owned attribute once, instead of allocating a point
            // object, subarrays and JS coordinate/color arrays for every point.
            const data = source.data(), components = data.colorComponents ?? 3;
            for (let i = 0; i < source.pointCount; i++) {
              for (let a = 0; a < 3; a++)
                v.setFloat32(
                  i * 32 + a * 4,
                  data.positions[i * 3 + a]! - snapshot.origin[a]!,
                  true,
                );
              for (let a = 0; a < 4; a++)
                v.setUint8(i * 32 + 12 + a, a < components ? data.colors?.[i * components + a] ?? 255 : 255);
              v.setUint32(i * 32 + 16, id.base + i, true);
              v.setFloat32(i * 32 + 20, (data.intensities?.[i] ?? 32768) / 65535, true);
              v.setFloat32(
                i * 32 + 24,
                (data.positions[i * 3 + 2]! - layer.dataset.bounds.min[2]) / range,
                true,
              );
              v.setUint32(i * 32 + 28, data.classifications?.[i] ?? 0, true);
            }
            const buffer = this.#device.createBuffer({
              size: raw.byteLength,
              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            created.push(buffer);
            this.#device.queue.writeBuffer(buffer, 0, raw);
            const owned = source.retain();
            retained.push(owned);
            gpu = {
              source,
              retained: owned,
              buffer,
              bytes: raw.byteLength,
              baseId: id.base,
            };
            this.#bufferCreations++;
          }
          nodes.set(key, gpu!);
          bytes += gpu!.bytes;
        }
        staged.set(layer, { uniform, group, nodes, bytes });
      }
      for (const [layer, old] of this.#layers) {
        const next = staged.get(layer);
        if (!next) {
          old.uniform.destroy();
          this.#ids.delete(layer);
        }
        for (const [key, n] of old.nodes)
          if (next?.nodes.get(key) !== n) {
            n.buffer.destroy();
            n.retained.dispose();
          }
      }
      this.#layers = staged;
      this.#retainedLayers = [...layers];
    } catch (e) {
      for (const b of created) b.destroy();
      for (const b of retained) b.dispose();
      throw e;
    }
  }
  async render(view: PointView, signal?: AbortSignal): Promise<void> {
    this.#guard();
    pointCancelled(signal);
    pointView(view);
    if (!view.viewProjection)
      pointError("Point rendering requires a view-projection matrix");
    if (!this.#color)
      this.resize(this.canvas.width || 1, this.canvas.height || 1);
    const start = performance.now();
    this.#view = structuredClone(view);
    for (const [layer, gpu] of this.#layers) {
      const { origin, style } = layer.snapshot(),
        s = normalizePointStyle(style),
        m = view.viewProjection,
        raw = new Float32Array(28);
      raw.set(Array.from(m));
      for (let r = 0; r < 4; r++)
        raw[12 + r] =
          m[r]! * origin[0] +
          m[r + 4]! * origin[1] +
          m[r + 8]! * origin[2] +
          m[r + 12]!;
      raw.set(
        [this.#width, this.#height, s.pointSize, s.shape === "circle" ? 1 : 0],
        16,
      );
      raw.set([s.color[0], s.color[1], s.color[2], s.color[3] * s.opacity], 20);
      raw[24] = ["rgb", "elevation", "intensity", "classification"].indexOf(
        s.colorMode,
      );
      this.#device.queue.writeBuffer(gpu.uniform, 0, raw);
    }
    const encoder = this.#device.createCommandEncoder(),
      clear = this.options.clearColor ?? [0.02, 0.03, 0.05, 1],
      pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.#color!.createView(),
            clearValue: [...clear],
            loadOp: "clear",
            storeOp: "store",
          },
          {
            view: this.#id!.createView(),
            clearValue: [0, 0, 0, 0],
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: this.#depth!.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
    pass.setPipeline(this.#pipeline);
    for (const l of this.#layers.values()) {
      pass.setBindGroup(0, l.group);
      for (const n of l.nodes.values()) {
        pass.setVertexBuffer(0, n.buffer);
        pass.draw(6, n.retained.pointCount);
      }
    }
    pass.end();
    encoder.copyTextureToTexture(
      { texture: this.#color! },
      { texture: this.#context.getCurrentTexture() },
      [this.#width, this.#height],
    );
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    this.#guard();
    pointCancelled(signal);
    this.#frames++;
    this.#durations.push(performance.now() - start);
    if (this.#durations.length > 36_000) this.#durations.shift();
  }
  async #read(
    texture: GPUTexture,
    width: number,
    height: number,
    x = 0,
    y = 0,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.#guard();
    pointCancelled(signal);
    const stride = Math.ceil((width * 4) / 256) * 256,
      size = stride * height;
    this.#admit(size);
    const buffer = this.#device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.#readbacks.add(buffer);
    try {
      const e = this.#device.createCommandEncoder();
      e.copyTextureToBuffer(
        { texture, origin: [x, y] },
        { buffer, bytesPerRow: stride, rowsPerImage: height },
        [width, height],
      );
      this.#device.queue.submit([e.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      pointCancelled(signal);
      this.#guard();
      const mapped = new Uint8Array(buffer.getMappedRange()),
        out = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++)
        out.set(
          mapped.subarray(row * stride, row * stride + width * 4),
          row * width * 4,
        );
      buffer.unmap();
      return out;
    } finally {
      buffer.destroy();
      this.#readbacks.delete(buffer);
    }
  }
  async readRgba(signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.#color) pointError("Point frame not rendered");
    const bytes = await this.#read(
      this.#color,
      this.#width,
      this.#height,
      0,
      0,
      signal,
    );
    if (this.#format === "bgra8unorm")
      for (let i = 0; i < bytes.length; i += 4) {
        const r = bytes[i]!;
        bytes[i] = bytes[i + 2]!;
        bytes[i + 2] = r;
      }
    return bytes;
  }
  async pick(
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<PointPickResult | null> {
    pointInteger(x, "pick x", 0, this.#width - 1);
    pointInteger(y, "pick y", 0, this.#height - 1);
    if (!this.#id) pointError("Point frame not rendered");
    const bytes = await this.#read(this.#id, 1, 1, x, y, signal),
      id = new DataView(bytes.buffer).getUint32(0, true);
    if (!id) return null;
    for (const [layer, gpu] of this.#layers)
      for (const [key, node] of gpu.nodes)
        if (id >= node.baseId && id < node.baseId + node.retained.pointCount) {
          const index = id - node.baseId,
            p = node.retained.point(index);
          return {
            id,
            layerName: layer.name,
            nodeKey: key,
            pointIndex: index,
            position: p.position,
            color: p.color,
          };
        }
    return null;
  }
  /** Recreates device resources and replays retained CPU layers without dataset IO. */
  async recover(): Promise<void> {
    pointLive(this.#disposed);
    const width = this.#width || this.canvas.width,
      height = this.#height || this.canvas.height;
    this.#recoverySnapshots ??= this.#retainedLayers.map((layer) => {
      const snapshot = layer.snapshot(),
        old = this.#layers.get(layer);
      if (old) {
        this.#recoverySources.set(
          layer,
          new Map(Array.from(old.nodes, ([key, n]) => [key, n.source])),
        );
        snapshot.nodes = Array.from(old.nodes, ([key, n]) => ({
          key,
          buffer: n.retained.retain(),
        }));
      }
      return { layer, snapshot };
    });
    this.#generation++;
    this.#lost = true;
    this.#release();
    this.#device.destroy();
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
      throw new Forge3DError(
        "WEBGPU_ADAPTER_UNAVAILABLE",
        "Point recovery adapter unavailable",
      );
    this.#device = await adapter.requestDevice();
    this.#lost = false;
    this.#layout = this.#createLayout();
    this.#pipeline = this.#createPipeline();
    this.#configure();
    this.#watchLoss();
    this.resize(width || 1, height || 1);
    this.#install(this.#recoverySnapshots);
    for (const [layer, gpu] of this.#layers)
      for (const [key, node] of gpu.nodes)
        node.source = this.#recoverySources.get(layer)?.get(key) ?? node.source;
    for (const { snapshot } of this.#recoverySnapshots)
      for (const { buffer } of snapshot.nodes) buffer.dispose();
    this.#recoverySnapshots = undefined;
    this.#recoverySources.clear();
    if (this.#view) await this.render(this.#view);
  }
  /** Pass false for per-frame allocation polling; the default includes timing percentiles. */
  getStats(includeTimings = true) {
    const times = includeTimings ? [...this.#durations].sort((a, b) => a - b) : [];
    return {
      frames: this.#frames,
      pointsRendered: Array.from(this.#layers.values()).reduce(
        (n, l) =>
          n +
          Array.from(l.nodes.values()).reduce(
            (n, b) => n + b.retained.pointCount,
            0,
          ),
        0,
      ),
      gpuBytes: this.#bytes(),
      peakGpuBytes: this.#peakBytes,
      memoryBudgetBytes: this.memoryBudgetBytes,
      bufferCreations: this.#bufferCreations,
      p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1]! : 0,
      disposed: this.#disposed,
      deviceLost: this.#lost,
    };
  }
  #release(): void {
    for (const l of this.#layers.values()) {
      l.uniform.destroy();
      for (const n of l.nodes.values()) {
        n.buffer.destroy();
        n.retained.dispose();
      }
    }
    this.#layers.clear();
    for (const b of this.#readbacks) b.destroy();
    this.#readbacks.clear();
    this.#color?.destroy();
    this.#id?.destroy();
    this.#depth?.destroy();
    this.#color = undefined;
    this.#id = undefined;
    this.#depth = undefined;
    this.#width = 0;
    this.#height = 0;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    this.#release();
    this.#ids.clear();
    this.#durations = [];
    this.#view = undefined;
    this.#retainedLayers = [];
    if (this.#recoverySnapshots)
      for (const { snapshot } of this.#recoverySnapshots)
        for (const { buffer } of snapshot.nodes) buffer.dispose();
    this.#recoverySnapshots = undefined;
    this.#recoverySources.clear();
    this.#context.unconfigure();
    this.#device.destroy();
  }
}
