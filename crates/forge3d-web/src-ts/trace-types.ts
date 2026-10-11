export type TraceVec3 = readonly [number, number, number];
export interface TraceRay {
  origin: TraceVec3;
  direction: TraceVec3;
  tMin?: number;
  tMax?: number;
}
export interface TraceHit {
  id: number;
  materialId: number;
  t: number;
  barycentric: TraceVec3;
  position: TraceVec3;
  normal: TraceVec3;
  frontFace: boolean;
  kind: "mesh" | "sdf";
  steps: number;
}
export interface TraceTriangle {
  v0: TraceVec3;
  v1: TraceVec3;
  v2: TraceVec3;
  id?: number;
  materialId?: number;
}
export interface TraceBounds {
  min: TraceVec3;
  max: TraceVec3;
}
export interface BvhBuildOptions {
  method?: "sah" | "lbvh";
  maxLeafSize?: number;
  memoryBudgetBytes?: number;
}
export interface BvhStats {
  triangleCount: number;
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  memoryUsageBytes: number;
  buildTimeMs: number;
  backend: "cpu" | "wasm" | "webgpu";
  method: "sah" | "lbvh";
}
export interface BvhNode {
  min: TraceVec3;
  max: TraceVec3;
  left: number;
  right: number;
  first: number;
  count: number;
}
export interface TraceMaterial {
  albedo?: TraceVec3;
  emission?: TraceVec3;
  metallic?: number;
  roughness?: number;
  ior?: number;
}
export interface TraceCamera {
  origin: TraceVec3;
  target: TraceVec3;
  up?: TraceVec3;
  fovY?: number;
}
export interface TraceLight {
  position: TraceVec3;
  color?: TraceVec3;
  intensity?: number;
  weight?: number;
  type?: "point" | "directional" | "disc";
  direction?: TraceVec3;
  normal?: TraceVec3;
  radius?: number;
}
export interface TraceMedium {
  sigmaA: TraceVec3;
  sigmaS: TraceVec3;
  g?: number;
  bounds: TraceBounds;
}
export type TraceTraversalMode = "hybrid" | "mesh-only" | "sdf-only";
export interface TraceSceneInput {
  triangles?: readonly TraceTriangle[];
  bvh?: import("./bvh.js").BvhHandle;
  sdf?: import("./sdf.js").SdfScene;
  materials?: readonly TraceMaterial[];
  lights?: readonly TraceLight[];
  environment?: TraceVec3;
  medium?: TraceMedium;
}
export interface PathTracerOptions {
  backend?: "webgpu" | "cpu";
  engine?: "megakernel" | "wavefront";
  width: number;
  height: number;
  seed?: number;
  maxBounces?: number;
  memoryBudgetBytes?: number;
  camera?: TraceCamera;
  traversalMode?: TraceTraversalMode;
  luminanceClamp?: number;
  restir?: Partial<import("./trace-sampling.js").RestirConfig> | false;
  guiding?: import("./trace-sampling.js").OnlineGuidingGrid;
}
export interface TraceRenderOptions {
  spp?: number;
  signal?: AbortSignal;
}
export interface TraceProgress {
  samples: number;
  progress: number;
  result: TraceResult;
}
export interface TraceResult {
  width: number;
  height: number;
  samples: number;
  color: Float32Array;
  albedo: Float32Array;
  normal: Float32Array;
  depth: Float32Array;
  id: Uint32Array;
  direct: Float32Array;
  indirect: Float32Array;
  emission: Float32Array;
  visibility: Float32Array;
  ao: Float32Array;
  bentNormal: Float32Array;
  variance: Float32Array;
}
export interface TraceMemoryReport {
  cpuBytes: number;
  gpuBytes: number;
  peakBytes: number;
  budgetBytes: number;
  cacheBytes: number;
  disposed: boolean;
}
