import { Forge3DError } from "./runtime-failure.js";
import { TraceScene, normalizeTraceCamera } from "./trace-scene.js";
import {
  packTraceScene,
  traceUniform,
  requestTraceDevice,
} from "./trace-gpu.js";
import { TRACE_QUERY_WGSL } from "./trace-wgsl.js";
import type {
  TraceRay,
  TraceHit,
  TraceSceneInput,
  TraceVec3,
  TraceTraversalMode,
} from "./trace-types.js";
import { ray, vec, cancelled, integer, traceLimit } from "./trace-math.js";
const QUERY =
  TRACE_QUERY_WGSL +
  `
struct Query {o:vec4f,d:vec4f};
struct Result {p:vec4f,n:vec4f,bary:vec4f,tags:vec4u};
@group(0) @binding(2) var<storage,read> queries:array<Query>;
@group(0) @binding(3) var<storage,read_write> results:array<Result>;
@compute @workgroup_size(64) fn query_rays(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=params.dims.x){return;}let r=queries[i];let h=scene_hit(r.o.xyz,r.d.xyz,r.o.w,r.d.w);var result:Result;result.p=vec4f(h.p,h.t);result.n=vec4f(h.n,f32(h.front));result.bary=vec4f(h.bary,0.);result.tags=vec4u(h.id,h.material,h.steps,select(0u,1u,h.steps>0u));results[i]=result;}
@compute @workgroup_size(64) fn evaluate_points(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=params.dims.x){return;}let value=sdf_eval(queries[i].o.xyz);var result:Result;result.p=vec4f(value.distance,0.,0.,0.);result.tags=vec4u(0u,value.material,0u,0u);results[i]=result;}
`;
/** One bounded cancellable compute batch. Dedicated buffers are destroyed on every exit. */
async function compute(
  input: TraceSceneInput,
  query: Float32Array,
  entry: string,
  options: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
    mode?: TraceTraversalMode;
  },
): Promise<ArrayBuffer> {
  cancelled(options.signal);
  const count = query.length / 8;
  integer(count, "query count");
  const budget = integer(
      options.memoryBudgetBytes ?? 512 * 1024 * 1024,
      "memoryBudgetBytes",
    ),
    scene = new TraceScene(input, budget, false),
    packed = packTraceScene(scene),
    bytes = packed.bytes.byteLength + count * 160 + 304;
  if (packed.counts[3]! > 256) {
    scene.dispose();
    traceLimit("SDF nodes", packed.counts[3]!, 256);
  }
  if (bytes > budget) {
    scene.dispose();
    traceLimit("trace query bytes", bytes, budget);
  }
  let device: GPUDevice;
  try {
    device =
      options.device ??
      (await requestTraceDevice(Math.max(query.byteLength, count * 64)));
  } catch (error) {
    scene.dispose();
    throw error;
  }
  if (count > device.limits.maxComputeWorkgroupsPerDimension * 64) {
    scene.dispose();
    if (!options.device) device.destroy();
    traceLimit(
      "query dispatch count",
      count,
      device.limits.maxComputeWorkgroupsPerDimension * 64,
    );
  }
  const buffers: GPUBuffer[] = [];
  let lost = false;
  device.lost.then(() => {
    lost = true;
  });
  const create = (size: number, usage: number): GPUBuffer => {
    if (
      size > device.limits.maxBufferSize ||
      size > device.limits.maxStorageBufferBindingSize
    )
      traceLimit(
        "query buffer bytes",
        size,
        Math.min(
          device.limits.maxBufferSize,
          device.limits.maxStorageBufferBindingSize,
        ),
      );
    const b = device.createBuffer({ size: Math.max(4, size), usage });
    buffers.push(b);
    return b;
  };
  device.pushErrorScope("validation");
  try {
    const params = create(304, 72),
      storage = create(packed.bytes.byteLength, 136),
      rays = create(query.byteLength, 136),
      output = create(count * 64, 132),
      readback = create(count * 64, 9);
    device.queue.writeBuffer(
      params,
      0,
      traceUniform(
        scene,
        {
          width: count,
          height: 1,
          seed: 1,
          maxBounces: 1,
          camera: normalizeTraceCamera({
            origin: [0, 0, 5],
            target: [0, 0, 0],
          }),
          mode: options.mode ?? "hybrid",
          clamp: 0,
          restir: undefined,
          guiding: undefined,
        },
        packed,
        0,
      ),
    );
    device.queue.writeBuffer(storage, 0, packed.bytes);
    device.queue.writeBuffer(
      rays,
      0,
      query.buffer as ArrayBuffer,
      query.byteOffset,
      query.byteLength,
    );
    const module = device.createShaderModule({ code: QUERY });
    const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: entry },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [params, storage, rays, output].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    cancelled(options.signal);
    if (lost)
      throw new Forge3DError("DEVICE_LOST", "Tracing query device lost");
    const data = readback.getMappedRange().slice(0);
    readback.unmap();
    const error = await device.popErrorScope();
    if (error)
      throw new Forge3DError("SHADER_COMPILATION_FAILED", error.message);
    return data;
  } catch (error) {
    await device.popErrorScope().catch(() => null);
    if (lost)
      throw new Forge3DError("DEVICE_LOST", "Tracing query device lost");
    throw error;
  } finally {
    for (const b of buffers) b.destroy();
    scene.dispose();
    if (!options.device) device.destroy();
  }
}
export async function traceRaysGpu(
  scene: TraceSceneInput,
  rays: readonly TraceRay[],
  options: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
    mode?: TraceTraversalMode;
  } = {},
): Promise<(TraceHit | undefined)[]> {
  if (!rays.length) return [];
  const input = new Float32Array(rays.length * 8);
  rays.forEach((r, i) => {
    const checked = ray(r);
    input.set(
      [...checked.origin, checked.tMin, ...checked.direction, checked.tMax],
      i * 8,
    );
  });
  const data = await compute(scene, input, "query_rays", options),
    v = new Float32Array(data),
    u = new Uint32Array(data);
  return rays.map((_, i) => {
    const at = i * 16;
    if (u[at + 12] === 0) return undefined;
    return {
      id: u[at + 12]!,
      materialId: u[at + 13]!,
      t: v[at + 3]!,
      position: [v[at]!, v[at + 1]!, v[at + 2]!] as TraceVec3,
      normal: [v[at + 4]!, v[at + 5]!, v[at + 6]!] as TraceVec3,
      frontFace: v[at + 7] !== 0,
      barycentric: [v[at + 8]!, v[at + 9]!, v[at + 10]!] as TraceVec3,
      kind: u[at + 15] ? "sdf" : "mesh",
      steps: u[at + 14]!,
    };
  });
}
export async function evaluateSdfGpu(
  scene: import("./sdf.js").SdfScene,
  points: readonly TraceVec3[],
  options: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ distance: number; materialId: number }[]> {
  if (!points.length) return [];
  const input = new Float32Array(points.length * 8);
  points.forEach((p, i) => input.set(vec(p), i * 8));
  const data = await compute({ sdf: scene }, input, "evaluate_points", options),
    v = new Float32Array(data),
    u = new Uint32Array(data);
  return points.map((_, i) => ({
    distance: scene.nodeCount() ? v[i * 16]! : Infinity,
    materialId: u[i * 16 + 13]!,
  }));
}
