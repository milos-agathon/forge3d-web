import { Forge3DError } from "./index.js";
import type { Forge3DScene } from "./index.js";
import type {
  PointData,
  PointBounds,
  PointVec3,
  PointView,
  PointNode,
  PointCloudDataset,
} from "./pointcloud-types.js";
import { Tileset, TilesetTraverser } from "./tiles3d.js";
import type { TilesetTraversalOptions, VisibleTile } from "./tiles3d.js";
import { decodeB3dm, decodePnts } from "./tiles3d-content.js";
import type { B3dmContent, PntsContent } from "./tiles3d-content.js";
import {
  PointCache,
  pointError,
  pointLive,
  pointLimit,
  pointCancelled,
  pointInteger,
} from "./pointcloud-common.js";
import { pointDataBytes, clonePointData } from "./pointcloud-buffer.js";
import {
  multiplyTileMatrices,
  transformTilePoint,
  TILE_IDENTITY,
  tileMatrix,
} from "./tiles3d-bounds.js";
import { meshBytes, recomputeMeshNormals } from "./mesh.js";
import type { MeshBuffers } from "./mesh.js";
import { transformMesh } from "./mesh-processing.js";
import { TerrainScatterBatch } from "./terrain-scatter.js";
import { PointCloudLayer } from "./pointcloud-layer.js";
export type TilePayload = PntsContent | B3dmContent;
export interface Tiles3dLayerOptions extends TilesetTraversalOptions {
  name?: string;
  maxBytes?: number;
  ownsTileset?: boolean;
  origin?: PointVec3;
}
export interface LoadedTile {
  selection: VisibleTile;
  content: TilePayload;
}
function contentBytes(c: TilePayload): number {
  return c.kind === "pnts"
    ? pointDataBytes(c.points) + c.batchBinary.length
    : c.gltf.primitives.reduce((n, p) => n + meshBytes(p.mesh), 0) +
        c.batchBinary.length;
}
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
/** Bounded content cache and transactional selection; replacements remain visible until ready. */
export class Tiles3dLayer {
  readonly name: string;
  readonly origin: PointVec3;
  readonly traverser: TilesetTraverser;
  readonly cache: PointCache<TilePayload>;
  #loaded: LoadedTile[] = [];
  #disposed = false;
  #update: AbortController | undefined;
  readonly maxBytes: number;
  readonly ownsTileset: boolean;
  constructor(
    readonly tileset: Tileset,
    options: Tiles3dLayerOptions = {},
  ) {
    this.name = options.name ?? "tiles3d";
    this.origin = options.origin ?? tileset.root.boundingVolume.center();
    this.traverser = new TilesetTraverser(options);
    this.maxBytes = options.maxBytes ?? tileset.io.maxBytes;
    this.ownsTileset = options.ownsTileset ?? false;
    this.cache = new PointCache(options.maxBytes ?? tileset.io.decoded.budget);
  }
  async update(view: PointView, signal?: AbortSignal): Promise<LoadedTile[]> {
    pointLive(this.#disposed);
    this.#update?.abort();
    const abort = new AbortController();
    this.#update = abort;
    const s = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    try {
      let selection = this.traverser.visibleTiles(this.tileset, view);
      for (let round = 0; round < 32; round++) {
        let expanded = false;
        for (const v of selection) {
          pointCancelled(s);
          expanded = (await this.tileset.expandExternal(v.tile, s)) || expanded;
        }
        if (!expanded) break;
        selection = this.traverser.visibleTiles(this.tileset, view);
        if (round === 31) pointError("External tileset chain exceeds limit");
      }
      const loaded: LoadedTile[] = [];
      let used = 0;
      for (const v of selection) {
        pointCancelled(s);
        const uri = v.tile.content!.uri;
        let content = this.cache.get(uri);
        if (!content) {
          const bytes = await this.tileset.io.read(uri, s),
            magic = new TextDecoder().decode(bytes.subarray(0, 4)),
            o = { maxBytes: this.maxBytes, signal: s };
          if (magic === "pnts") content = decodePnts(bytes, o);
          else if (magic === "b3dm")
            content = await decodeB3dm(bytes, {
              ...o,
              baseUrl: uri,
              resolveUri: (path, signal) => this.tileset.io.read(path, signal),
            });
          else
            throw new Forge3DError(
              "UNSUPPORTED_FEATURE",
              `Tile content ${magic} is unsupported`,
              { reason: "tiles-content-unavailable", uri },
            );
          this.cache.put(uri, content, contentBytes(content));
        }
        used += contentBytes(content);
        pointLimit(used, this.maxBytes);
        loaded.push({ selection: v, content });
      }
      pointCancelled(s);
      pointLive(this.#disposed);
      this.#loaded = loaded;
      return this.loadedTiles();
    } finally {
      if (this.#update === abort) this.#update = undefined;
    }
  }
  loadedTiles(): LoadedTile[] {
    pointLive(this.#disposed);
    return [...this.#loaded];
  }
  pointData(): PointData {
    pointLive(this.#disposed);
    const points = this.#loaded.filter(
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
    return { positions, colors, colorComponents: 4 };
  }
  /** Point tiles use the compact point renderer. Mesh tiles use W15 scene batches. */
  asPointCloudLayer(): PointCloudLayer {
    let points: PointData | undefined = this.pointData();
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.positions.length; i++) {
      const a = i % 3;
      min[a] = Math.min(min[a]!, points.positions[i]!);
      max[a] = Math.max(max[a]!, points.positions[i]!);
    }
    const bounds: PointBounds = points.positions.length
        ? { min: min as unknown as PointVec3, max: max as unknown as PointVec3 }
        : this.tileset.root.boundingVolume.aabb(),
      node: PointNode = {
        key: "0-0-0-0",
        depth: 0,
        bounds,
        spacing: 1,
        children: [],
        pointCount: points.positions.length / 3,
      };
    let disposed = false;
    const dataset: PointCloudDataset = {
      bounds,
      totalPoints: node.pointCount,
      crs: undefined,
      rootNode() {
        pointLive(disposed);
        return node;
      },
      async children() {
        pointLive(disposed);
        return [];
      },
      async readPoints() {
        pointLive(disposed);
        return clonePointData(points!);
      },
      dispose() {
        disposed = true;
        points = undefined;
      },
    };
    return new PointCloudLayer(dataset, {
      name: this.name,
      origin: this.origin,
      ownsDataset: true,
      pointBudget: node.pointCount,
      maxBytes: this.maxBytes,
    });
  }
  meshes(): {
    name: string;
    mesh: MeshBuffers;
    material: Readonly<Record<string, unknown>> | undefined;
  }[] {
    pointLive(this.#disposed);
    const result: {
      name: string;
      mesh: MeshBuffers;
      material: Readonly<Record<string, unknown>> | undefined;
    }[] = [];
    let used = 0;
    for (const item of this.#loaded) {
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
    return result;
  }
  addMeshesToScene(scene: Forge3DScene): void {
    const meshes = this.meshes();
    for (const m of meshes) {
      const material = m.material;
      if (
        material &&
        (material.normalTexture ||
          material.emissiveTexture ||
          (material.pbrMetallicRoughness as Record<string, unknown> | undefined)
            ?.baseColorTexture ||
          (material.pbrMetallicRoughness as Record<string, unknown> | undefined)
            ?.metallicRoughnessTexture)
      )
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Tile texture assets need explicit W15 TextureSet bindings",
          { reason: "tile-texture-bindings-required" },
        );
    }
    const staged = scene.copy();
    try {
      const retained = staged
        .getScatterBatches()
        .filter((b) => !b.name?.startsWith(this.name + ":"));
      for (const m of meshes) {
        const pbr = m.material?.pbrMetallicRoughness as
          | Record<string, unknown>
          | undefined;
        staged.setMaterial(m.name, {
          id: m.name,
          baseColor: (pbr?.baseColorFactor ?? [1, 1, 1, 1]) as [
            number,
            number,
            number,
            number,
          ],
          roughness: (pbr?.roughnessFactor ?? 1) as number,
          metallic: (pbr?.metallicFactor ?? 1) as number,
        });
      }
      const materials = staged.getMaterials(),
        batches = meshes.map((m) => {
          const zToY = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
            mesh = transformMesh(m.mesh, zToY);
          return new TerrainScatterBatch({
            name: m.name,
            levels: [{ mesh }],
            transforms: new Float32Array(TILE_IDENTITY),
            materialIndex: materials.find((s) => s.slot === m.name)!.index,
          });
        });
      staged.setScatterBatches([...retained, ...batches]);
      for (const m of staged.getMaterials())
        scene.setMaterial(m.slot, m.material);
      scene.setScatterBatches(staged.getScatterBatches());
    } finally {
      staged.dispose();
    }
  }
  stats() {
    return {
      visibleTileCount: this.#loaded.length,
      pointCount: this.#loaded.reduce(
        (n, t) => n + (t.content.kind === "pnts" ? t.content.pointCount : 0),
        0,
      ),
      triangles: this.#loaded.reduce(
        (n, t) =>
          n +
          (t.content.kind === "b3dm"
            ? t.content.gltf.primitives.reduce(
                (n, p) => n + p.mesh.indices.length / 3,
                0,
              )
            : 0),
        0,
      ),
      loadedBytes: this.#loaded.reduce(
        (n, t) => n + contentBytes(t.content),
        0,
      ),
      cache: this.cache.stats(),
      disposed: this.#disposed,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#update?.abort();
    this.#loaded = [];
    this.cache.clear();
    if (this.ownsTileset) this.tileset.dispose();
  }
}
