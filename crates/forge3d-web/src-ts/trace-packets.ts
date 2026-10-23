import type { TraceScene } from './trace-scene.js';
import type { CpuTraceSettings } from './trace-cpu.js';
import type { TraceResult, TraceVec3, TraceHit } from './trace-types.js';
import { packGuidingWeights } from './trace-sampling.js';
import { unit, sub, cross, luminance, f } from './trace-math.js';
export { TRACE_RECORD, TRACE_UNIFORM_BYTES, TRACE_PARAMS_WGSL } from './trace-packet-layout.js';
import { TRACE_RECORD, TRACE_UNIFORM_BYTES, uniformOffset } from './trace-packet-layout.js';
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
  const data = new ArrayBuffer(TRACE_UNIFORM_BYTES),
    u = new Uint32Array(data),
    v = new Float32Array(data),
    forward = unit(sub(s.camera.target, s.camera.origin)),
    right = unit(cross(forward, s.camera.up)),
    up = cross(right, forward);
  u.set([s.width, s.height, sample, s.maxBounces], uniformOffset.dims);
  u.set(packed.counts, uniformOffset.counts);
  u.set(
    [
      s.mode === "hybrid" ? 0 : s.mode === "sdf-only" ? 1 : 2,
      s.seed,
      scene.lights.length,
      s.restir?.initialCandidates ?? 0,
    ],
    uniformOffset.mode,
  );
  u.set(packed.offsets0, uniformOffset.offsets0);
  u.set(packed.offsets1, uniformOffset.offsets1);
  v.set(s.camera.origin, uniformOffset.origin);
  v.set(forward, uniformOffset.forward);
  v.set(right, uniformOffset.right);
  v.set(up, uniformOffset.up);
  v.set(scene.environment, uniformOffset.environment);
  // extra.w must have zero bits: WGSL contribution barriers XOR this word.
  v.set(
    [Math.tan((s.camera.fovY * Math.PI) / 360), s.width / s.height, s.clamp, 0],
    uniformOffset.extra,
  );
  if (scene.medium) {
    v.set(scene.medium.bounds.min, uniformOffset.mediumMin);
    v.set(scene.medium.bounds.max, uniformOffset.mediumMax);
    v.set([...scene.medium.sigmaA, scene.medium.g ?? 0], uniformOffset.mediumA);
    v.set([...scene.medium.sigmaS, 1], uniformOffset.mediumS);
  }
  u.set(
    [
      s.restir?.temporalNeighbors ?? 0,
      s.restir?.spatialNeighbors ?? 0,
      s.restir?.maxTemporalAge ?? 0,
      s.guiding?.binsPerCell ?? 0,
    ],
    uniformOffset.reuse,
  );
  v.set(
    [
      s.restir?.depthThreshold ?? 0,
      s.restir?.normalThreshold ?? 0,
      s.restir?.spatialRadius ?? 0,
      s.restir?.biasCorrection ? 1 : 0,
    ],
    uniformOffset.thresholds,
  );
  const bounds = scene.sdf?.getBounds();
  if (bounds) {
    v.set([...bounds.min, 1], uniformOffset.sdfMin);
    v.set(bounds.max, uniformOffset.sdfMax);
  }
  return data;
}
export function emptyTraceResult(
  width: number,
  height: number,
  samples = 0,
): TraceResult {
  const n = width * height,
    a = () => new Float32Array(n * 3),
    b = () => new Float32Array(n);
  return {
    width,
    height,
    samples,
    color: a(),
    albedo: a(),
    normal: a(),
    depth: b(),
    id: new Uint32Array(n),
    direct: a(),
    indirect: a(),
    emission: a(),
    visibility: b(),
    ao: b(),
    bentNormal: a(),
    variance: b(),
  };
}
/** Average linear AOVs; nearest first-sample ID/depth remains stable for integer picking. */
export function decodeTraceRecords(
  data: Float32Array,
  width: number,
  height: number,
  samples: number,
): TraceResult {
  const out = emptyTraceResult(width, height, samples),
    bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  for (let i = 0; i < width * height; i++) {
    const base = i * TRACE_RECORD.words;
    for (const [name, offset] of [
      ["color", TRACE_RECORD.color],
      ["albedo", TRACE_RECORD.albedo],
      ["normal", TRACE_RECORD.normal],
      ["direct", TRACE_RECORD.direct],
      ["indirect", TRACE_RECORD.indirect],
      ["emission", TRACE_RECORD.emission],
      ["bentNormal", TRACE_RECORD.bentNormal],
    ] as const)
      out[name].set(
        data.subarray(base + offset, base + offset + 3).map((v) => v / samples),
        i * 3,
      );
    out.id[i] = bits[base + TRACE_RECORD.id]!;
    out.depth[i] = data[base + TRACE_RECORD.depth]!;
    out.visibility[i] = data[base + TRACE_RECORD.visibility]! / samples;
    out.ao[i] = data[base + TRACE_RECORD.ao]! / samples;
    const color: TraceVec3 = [
      out.color[i * 3]!,
      out.color[i * 3 + 1]!,
      out.color[i * 3 + 2]!,
    ];
    out.variance[i] = Math.max(
      0,
      data[base + TRACE_RECORD.variance]! / samples - luminance(color) ** 2,
    );
    const n = unit([
        out.normal[i * 3]!,
        out.normal[i * 3 + 1]!,
        out.normal[i * 3 + 2]!,
      ]),
      b = unit([
        out.bentNormal[i * 3]!,
        out.bentNormal[i * 3 + 1]!,
        out.bentNormal[i * 3 + 2]!,
      ]);
    out.normal.set(n, i * 3);
    out.bentNormal.set(b, i * 3);
  }
  return out;
}
export function accumulateRecord(
  sum: Float32Array,
  record: Float32Array,
  pixel: number,
  sample: number,
): void {
  const off = pixel * TRACE_RECORD.words;
  const ids = new Uint32Array(sum.buffer),
    inputIds = new Uint32Array(record.buffer);
  for (let i = 0; i < TRACE_RECORD.words; i++) {
    if (i === TRACE_RECORD.training || i === TRACE_RECORD.guidingBin) {
      ids[off + i] = inputIds[i]!;
    } else if (i === TRACE_RECORD.id) {
      if (sample === 0) ids[off + i] = inputIds[i]!;
    } else if (i === TRACE_RECORD.depth) {
      if (sample === 0) sum[off + i] = record[i]!;
    } else sum[off + i] = f(sum[off + i]! + record[i]!);
  }
}
export const TRACE_HIT_BYTES = 64;
export const TRACE_QUERY_WGSL_LAYOUT = 'struct Query {o:vec4f,d:vec4f};\nstruct Result {p:vec4f,n:vec4f,bary:vec4f,tags:vec4u};';
export function writeTraceHit(records: ArrayBuffer, index: number, hit: TraceHit | undefined): void {
  if(!hit)return;
  const floats=new Float32Array(records),words=new Uint32Array(records),at=index*16;
  floats.set([...hit.position,hit.t,...hit.normal,Number(hit.frontFace),...hit.barycentric,0],at);
  words.set([hit.id,hit.materialId,hit.steps,Number(hit.kind==='sdf')],at+12);
}
export function readTraceHits(data: ArrayBuffer): (TraceHit|undefined)[] {
 const v=new Float32Array(data),u=new Uint32Array(data);
 return Array.from({length:data.byteLength/TRACE_HIT_BYTES},(_,i)=>{
 const at=i*16;if(u[at+12]===0)return undefined;
 return {id:u[at+12]!,materialId:u[at+13]!,t:v[at+3]!,position:[v[at]!,v[at+1]!,v[at+2]!] as TraceVec3,normal:[v[at+4]!,v[at+5]!,v[at+6]!] as TraceVec3,frontFace:v[at+7]!==0,barycentric:[v[at+8]!,v[at+9]!,v[at+10]!] as TraceVec3,kind:u[at+15]?'sdf':'mesh',steps:u[at+14]!};
 });
}
