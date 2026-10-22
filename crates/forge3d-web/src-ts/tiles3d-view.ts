import type { LoadedTile } from './tiles3d-layer.js';
import type { PntsContent } from './tiles3d-content.js';
import type { PointData, PointVec3 } from './pointcloud-types.js';
import { multiplyTileMatrices, transformTilePoint, TILE_IDENTITY, tileMatrix } from './tiles3d-bounds.js';
import { pointError, pointInteger, pointLimit } from './pointcloud-common.js';
import { meshBytes, recomputeMeshNormals, type MeshBuffers } from './mesh.js';
import { transformMesh } from './mesh-processing.js';
export interface TileMesh { name:string; mesh:MeshBuffers; material:Readonly<Record<string,unknown>>|undefined; }
function rowMatrix(m: readonly number[]): number[] {
  return Array.from(
    { length: 16 },
    (_, i) => m[(i % 4) * 4 + Math.floor(i / 4)]!,
  );
}
function nodeMatrix(n: Readonly<Record<string, unknown>>): number[] {
  if (n.matrix !== undefined) return tileMatrix(n.matrix);
  const t = (n.translation ?? [0, 0, 0]) as number[],
    s = (n.scale ?? [1, 1, 1]) as number[],
    q = (n.rotation ?? [0, 0, 0, 1]) as number[];
  if (
    !Array.isArray(t) ||
    !Array.isArray(s) ||
    !Array.isArray(q) ||
    t.length !== 3 ||
    s.length !== 3 ||
    q.length !== 4 ||
    [...t, ...s, ...q].some((x) => !Number.isFinite(x)) ||
    Math.abs(Math.hypot(...q) - 1) > 1e-5
  )
    pointError("Invalid glTF node TRS");
  const [x, y, z, w] = q as [number, number, number, number];
  return [
    (1 - 2 * y * y - 2 * z * z) * s[0]!,
    (2 * x * y + 2 * z * w) * s[0]!,
    (2 * x * z - 2 * y * w) * s[0]!,
    0,
    (2 * x * y - 2 * z * w) * s[1]!,
    (1 - 2 * x * x - 2 * z * z) * s[1]!,
    (2 * y * z + 2 * x * w) * s[1]!,
    0,
    (2 * x * z + 2 * y * w) * s[2]!,
    (2 * y * z - 2 * x * w) * s[2]!,
    (1 - 2 * x * x - 2 * y * y) * s[2]!,
    0,
    ...t,
    1,
  ];
}
/** Immutable selection view: each transform/aggregation is performed once, then reused. */
export class CommittedTileView {
    #points:PointData|undefined;
    #meshes:TileMesh[]|undefined;
    #sceneMeshes=new WeakMap<TileMesh,MeshBuffers>();
    readonly origin:PointVec3;
    constructor(private readonly loaded:readonly LoadedTile[],readonly name:string,origin:PointVec3,readonly maxBytes:number){this.origin=[...origin];}
    sceneMesh(item:TileMesh):MeshBuffers {
        let mesh=this.#sceneMeshes.get(item);
        if(!mesh){mesh=transformMesh(item.mesh,[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1]);this.#sceneMeshes.set(item,mesh);}return mesh;
    }
  points(): PointData {
    if(this.#points)return this.#points;
    const points = this.loaded.filter(
        (t): t is LoadedTile & { content: PntsContent } =>
          t.content.kind === "pnts",
      ),
      count = points.reduce((n, t) => n + t.content.pointCount, 0);
    pointLimit(count * 28, this.maxBytes);
    const positions = new Float64Array(count * 3),
      colors = new Uint8Array(count * 4);
    let cursor = 0;
    for (const t of points) {
      const d = t.content.points,
        c = d.colorComponents ?? 3;
      for (let i = 0; i < t.content.pointCount; i++) {
        positions.set(
          transformTilePoint(t.selection.worldTransform, [
            d.positions[i * 3]!,
            d.positions[i * 3 + 1]!,
            d.positions[i * 3 + 2]!,
          ]),
          cursor * 3,
        );
        for (let a = 0; a < 4; a++)
          colors[cursor * 4 + a] = a < c ? (d.colors?.[i * c + a] ?? 255) : 255;
        cursor++;
      }
    }
    return this.#points = { positions, colors, colorComponents: 4 };
  }
  meshes(): {
    name: string;
    mesh: MeshBuffers;
    material: Readonly<Record<string, unknown>> | undefined;
  }[] {
    if(this.#meshes)return this.#meshes;
    const result: {
      name: string;
      mesh: MeshBuffers;
      material: Readonly<Record<string, unknown>> | undefined;
    }[] = [];
    let used = 0;
    for (const item of this.loaded) {
      if (item.content.kind !== "b3dm") continue;
      const { gltf, rtcCenter } = item.content,
        base = [...item.selection.worldTransform],
        rtc = [...TILE_IDENTITY];
      rtc[12] = rtcCenter[0];
      rtc[13] = rtcCenter[1];
      rtc[14] = rtcCenter[2];
      // OGC b3dm glTF is Y-up; tile Cartesian coordinates are Z-up.
      const yToZ = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
        world = multiplyTileMatrices(multiplyTileMatrices(base, rtc), yToZ);
      world[12] = world[12]! - this.origin[0];
      world[13] = world[13]! - this.origin[1];
      world[14] = world[14]! - this.origin[2];
      const emit = (meshIndex: number, matrix: number[], suffix: string) => {
        for (const p of gltf.primitives.filter(
          (p) => p.meshIndex === meshIndex,
        )) {
          const mesh = transformMesh(
            p.mesh.normals.length ? p.mesh : recomputeMeshNormals(p.mesh),
            rowMatrix(matrix),
          );
          used += meshBytes(mesh);
          pointLimit(used, this.maxBytes);
          result.push({
            name: `${this.name}:${item.selection.tile.id}:${suffix}:${p.primitiveIndex}`,
            mesh,
            material:
              p.material === null ? undefined : gltf.materials[p.material],
          });
        }
      };
      if (!gltf.nodes.length) {
        for (const mi of new Set(gltf.primitives.map((p) => p.meshIndex)))
          emit(mi, world, `mesh-${mi}`);
        continue;
      }
      const scene = gltf.scenes[gltf.defaultScene ?? 0],
        children = new Set(
          gltf.nodes.flatMap((n) => (n.children ?? []) as number[]),
        );
      const roots = scene
        ? ((scene.nodes ?? []) as number[])
        : gltf.nodes.map((_, i) => i).filter((i) => !children.has(i));
      const seen = new Set<number>();
      const visit = (id: number, parent: number[], depth: number) => {
        pointInteger(id, "glTF node", 0, gltf.nodes.length - 1);
        if (depth > 128 || seen.has(id))
          pointError("Cyclic/shared glTF scene node");
        seen.add(id);
        const n = gltf.nodes[id]!,
          matrix = multiplyTileMatrices(parent, nodeMatrix(n));
        if (n.mesh !== undefined)
          emit(
            pointInteger(n.mesh as number, "glTF mesh"),
            matrix,
            `node-${id}`,
          );
        if (n.children !== undefined && !Array.isArray(n.children))
          pointError("Invalid glTF children");
        for (const child of (n.children as number[] | undefined) ?? [])
          visit(child, matrix, depth + 1);
      };
      for (const root of roots) visit(root, world, 0);
    }
    return this.#meshes=result;
  }
}
