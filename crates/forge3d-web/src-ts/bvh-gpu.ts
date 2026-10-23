import { BvhHandle } from "./bvh.js";
import type { TraceTriangle, BvhBuildOptions, BvhNode } from "./trace-types.js";
import { requestTraceDevice } from "./trace-gpu.js";
import { Forge3DError } from "./runtime-failure.js";
import { integer, traceLimit, cancelled, traceInvalid } from "./trace-math.js";
const SHADER = `
struct Params {count:u32,shift:u32,blocks:u32,leaves:u32,lo:vec4f,hi:vec4f,level:u32,first:u32,nodes:u32,pad:u32};
struct Triangle {a:vec4f,b:vec4f,c:vec4f,tags:vec4u};
struct Pair {code:u32,index:u32};
struct Node {lo:vec4f,hi:vec4f,tags:vec4u};
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(2) var<storage,read_write> pairs:array<Pair>;
@group(0) @binding(3) var<storage,read_write> sorted:array<Pair>;
@group(0) @binding(4) var<storage,read_write> counts:array<u32>;
@group(0) @binding(5) var<storage,read_write> nodes:array<Node>;
@group(0) @binding(6) var<storage,read_write> indices:array<u32>;
@group(0) @binding(7) var<storage,read> depths:array<u32>;
fn spread(v:u32)->u32 {var x=v&1023u;x=(x|(x<<16u))&0x030000ffu;x=(x|(x<<8u))&0x0300f00fu;x=(x|(x<<4u))&0x030c30c3u;x=(x|(x<<2u))&0x09249249u;return x;}
@compute @workgroup_size(256) fn morton(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=p.count){return;}let t=triangles[i];let lo=min(t.a.xyz,min(t.b.xyz,t.c.xyz));let hi=max(t.a.xyz,max(t.b.xyz,t.c.xyz));let center=(lo+hi)*0.5;let q=vec3u(clamp(floor((center-p.lo.xyz)/max(p.hi.xyz-p.lo.xyz,vec3f(1e-20))*1024.),vec3f(0.),vec3f(1023.)));pairs[i]=Pair(spread(q.x)|(spread(q.y)<<1u)|(spread(q.z)<<2u),i);}
var<workgroup> histogram:array<atomic<u32>,4>;
@compute @workgroup_size(256) fn radix_count(@builtin(global_invocation_id) gid:vec3u,@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){if(lid.x<4u){atomicStore(&histogram[lid.x],0u);}workgroupBarrier();if(gid.x<p.count){atomicAdd(&histogram[(pairs[gid.x].code>>p.shift)&3u],1u);}workgroupBarrier();if(lid.x<4u){counts[wid.x*4u+lid.x]=atomicLoad(&histogram[lid.x]);}}
@compute @workgroup_size(1) fn radix_prefix(){var total=0u;for(var bucket=0u;bucket<4u;bucket++){for(var block=0u;block<p.blocks;block++){let at=block*4u+bucket;let count=counts[at];counts[at]=total;total+=count;}}}
var<workgroup> buckets:array<u32,256>;
@compute @workgroup_size(256) fn radix_scatter(@builtin(global_invocation_id) gid:vec3u,@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){buckets[lid.x]=4u;if(gid.x<p.count){buckets[lid.x]=(pairs[gid.x].code>>p.shift)&3u;}workgroupBarrier();if(gid.x>=p.count){return;}let bucket=buckets[lid.x];var rank=0u;for(var j=0u;j<lid.x;j++){if(buckets[j]==bucket){rank++;}}sorted[counts[wid.x*4u+bucket]+rank]=pairs[gid.x];}
@compute @workgroup_size(64) fn topology(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=p.nodes){return;}var n:Node;n.lo=vec4f(1e30);n.hi=vec4f(-1e30);if(i<p.leaves-1u){n.tags=vec4u(i*2u+1u,i*2u+2u,0u,0u);}else{let leaf=i-(p.leaves-1u);let base=p.count/p.leaves;let extra=p.count%p.leaves;let first=leaf*base+min(leaf,extra);let count=base+select(0u,1u,leaf<extra);n.tags=vec4u(0u,0u,first,count);}nodes[i]=n;if(i<p.count){indices[i]=pairs[i].index;}}
@compute @workgroup_size(64) fn reorder(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i<p.count){indices[i]=pairs[i].index;}}
@compute @workgroup_size(64) fn bounds(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=p.nodes||depths[i]!=p.level){return;}var n=nodes[i];var lo=vec3f(1e30);var hi=vec3f(-1e30);if(n.tags.w>0u){for(var j=0u;j<n.tags.w;j++){let t=triangles[indices[n.tags.z+j]];lo=min(lo,min(t.a.xyz,min(t.b.xyz,t.c.xyz)));hi=max(hi,max(t.a.xyz,max(t.b.xyz,t.c.xyz)));}}else if(n.tags.x!=0u||n.tags.y!=0u){lo=min(nodes[n.tags.x].lo.xyz,nodes[n.tags.y].lo.xyz);hi=max(nodes[n.tags.x].hi.xyz,nodes[n.tags.y].hi.xyz);}n.lo=vec4f(lo,0.);n.hi=vec4f(hi,0.);nodes[i]=n;}
`;
async function gpuBuild(
  handle: BvhHandle,
  options: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
  },
  refit: boolean,
): Promise<void> {
  cancelled(options.signal);
  const count = handle.triangles.length,
    budget = integer(
      options.memoryBudgetBytes ?? 512 * 1024 * 1024,
      "memoryBudgetBytes",
    ),
    leafSize = 4;
  let leaves = 1;
  while (leaves < Math.ceil(count / leafSize)) leaves *= 2;
  const nodeCount = refit ? handle.nodes.length : leaves * 2 - 1,
    bytes = count * 100 + nodeCount * 100 + Math.ceil(count / 256) * 16 + 80;
  if (bytes > budget) traceLimit("LBVH bytes", bytes, budget);
  const device =
      options.device ??
      (await requestTraceDevice(Math.max(count * 64, nodeCount * 48))),
    buffers: GPUBuffer[] = [];
  const create = (size: number, usage: number): GPUBuffer => {
    if (size > device.limits.maxStorageBufferBindingSize)
      traceLimit(
        "LBVH storage buffer",
        size,
        device.limits.maxStorageBufferBindingSize,
      );
    const b = device.createBuffer({ size: Math.max(4, size), usage });
    buffers.push(b);
    return b;
  };
  const start = performance.now();
  device.pushErrorScope("validation");
  try {
    const uniform = create(80, 72),
      triangles = create(count * 64, 136),
      pairs = [create(count * 8, 128), create(count * 8, 128)],
      counts = create(Math.ceil(count / 256) * 16, 128),
      nodes = create(nodeCount * 48, 140),
      indices = create(count * 4, 140),
      depths = create(nodeCount * 4, 136),
      readback = create(nodeCount * 48 + count * 4, 9);
    device.queue.writeBuffer(triangles, 0, handle.packTriangles());
    const depth = new Uint32Array(nodeCount);
    let maxDepth = 0;
    if (refit) {
      const visit = (i: number, d: number): void => {
        depth[i] = d;
        maxDepth = Math.max(d, maxDepth);
        const n = handle.nodes[i]!;
        if (!n.count && (n.left || n.right)) {
          visit(n.left, d + 1);
          visit(n.right, d + 1);
        }
      };
      visit(0, 0);
      device.queue.writeBuffer(nodes, 0, handle.packNodes());
      device.queue.writeBuffer(indices, 0, handle.indices.slice().buffer);
    } else
      for (let i = 0; i < nodeCount; i++) {
        depth[i] = Math.floor(Math.log2(i + 1));
        maxDepth = Math.max(maxDepth, depth[i]!);
      }
    device.queue.writeBuffer(depths, 0, depth);
    const layout = device.createBindGroupLayout({
        entries: Array.from({ length: 8 }, (_, binding) => ({
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
      }),
      pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [layout],
      }),
      module = device.createShaderModule({ code: SHADER });
    const pipelines = new Map<string, GPUComputePipeline>();
    for (const entryPoint of [
      "morton",
      "radix_count",
      "radix_prefix",
      "radix_scatter",
      "topology",
      "reorder",
      "bounds",
    ])
      pipelines.set(
        entryPoint,
        await device.createComputePipelineAsync({
          layout: pipelineLayout,
          compute: { module, entryPoint },
        }),
      );
    const groups = pairs.map((pair, i) =>
      device.createBindGroup({
        layout,
        entries: [
          uniform,
          triangles,
          pair,
          pairs[1 - i]!,
          counts,
          nodes,
          indices,
          depths,
        ].map((buffer, binding) => ({ binding, resource: { buffer } })),
      }),
    );
    const update = (shift = 0, level = 0): void => {
      const b = new ArrayBuffer(80),
        u = new Uint32Array(b),
        f = new Float32Array(b);
      u.set([count, shift, Math.ceil(count / 256), leaves], 0);
      f.set(handle.worldBounds.min, 4);
      f.set(handle.worldBounds.max, 8);
      u.set([level, 0, nodeCount, 0], 12);
      device.queue.writeBuffer(uniform, 0, b);
    };
    const dispatch = (entries: readonly [string, number][], swap = 0): void => {
      const encoder = device.createCommandEncoder();
      for (const [name, n] of entries) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.get(name)!);
        pass.setBindGroup(0, groups[swap]!);
        pass.dispatchWorkgroups(Math.max(1, n));
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
    };
    if (!refit) {
      update();
      dispatch([["morton", Math.ceil(count / 256)]]);
      for (let pass = 0; pass < 15; pass++) {
        update(pass * 2);
        dispatch(
          [
            ["radix_count", Math.ceil(count / 256)],
            ["radix_prefix", 1],
            ["radix_scatter", Math.ceil(count / 256)],
          ],
          pass % 2,
        );
      }
      update();
      dispatch(
        [
          ["topology", Math.ceil(nodeCount / 64)],
          ["reorder", Math.ceil(count / 64)],
        ],
        1,
      );
    }
    for (let d = maxDepth; d >= 0; d--) {
      update(0, d);
      dispatch([["bounds", Math.ceil(nodeCount / 64)]]);
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(nodes, 0, readback, 0, nodeCount * 48);
    encoder.copyBufferToBuffer(indices, 0, readback, nodeCount * 48, count * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    cancelled(options.signal);
    const data = readback.getMappedRange().slice(0);
    readback.unmap();
    const error = await device.popErrorScope();
    if (error)
      throw new Forge3DError("SHADER_COMPILATION_FAILED", error.message);
    const fv = new Float32Array(data),
      uv = new Uint32Array(data),
      replacement: BvhNode[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const at = i * 12;
      replacement.push({
        min: [fv[at]!, fv[at + 1]!, fv[at + 2]!],
        max: [fv[at + 4]!, fv[at + 5]!, fv[at + 6]!],
        left: uv[at + 8]!,
        right: uv[at + 9]!,
        first: uv[at + 10]!,
        count: uv[at + 11]!,
      });
    }
    handle.install({triangles:handle.triangles,nodes:replacement,indices:uv.slice(nodeCount*12),stats:{method:"lbvh",backend:"webgpu",buildTimeMs:performance.now()-start}});
  } catch (error) {
    await device.popErrorScope().catch(() => null);
    throw error;
  } finally {
    for (const b of buffers) b.destroy();
    if (!options.device) device.destroy();
  }
}
export async function buildBvhGpu(
  triangles: readonly TraceTriangle[],
  options: BvhBuildOptions & { device?: GPUDevice; signal?: AbortSignal } = {},
): Promise<BvhHandle> {
  if (options.maxLeafSize !== undefined && options.maxLeafSize !== 4)
    traceInvalid("GPU LBVH maxLeafSize is 4");
  const start = performance.now();
  const handle = BvhHandle.prepare(triangles, { ...options, method: "lbvh" });
  try {
    await gpuBuild(handle, options, false);
    handle.stats.buildTimeMs = performance.now() - start;
    return handle;
  } catch (error) {
    handle.dispose();
    throw error;
  }
}
export async function refitBvhGpu(
  handle: BvhHandle,
  triangles: readonly TraceTriangle[],
  options: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  cancelled(options.signal);
  await handle.refitOwned(triangles,candidate=>gpuBuild(candidate,options,true));
}
