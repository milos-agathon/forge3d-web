import { CommittedTileView, type TileMesh } from './tiles3d-view.js';
import { Forge3DError } from "./runtime-failure.js";
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
import { meshBytes } from "./mesh.js";
import type { MeshBuffers } from "./mesh.js";
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
    views.set(this,new CommittedTileView([],this.name,this.origin,this.maxBytes));
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
      views.set(this,new CommittedTileView(loaded,this.name,this.origin,this.maxBytes));
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
  pointData(): PointData { pointLive(this.#disposed); return clonePointData(views.get(this)!.points()); }
  /** Point tiles use the compact point renderer. Mesh tiles use W15 scene batches. */
  asPointCloudLayer(): PointCloudLayer {
    pointLive(this.#disposed);
    let points: PointData | undefined = views.get(this)!.points();
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
  meshes(): TileMesh[] { pointLive(this.#disposed); return structuredClone(views.get(this)!.meshes()); }
  addMeshesToScene(scene: Forge3DScene): void {
    pointLive(this.#disposed);
    const meshes = views.get(this)!.meshes();
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
          const mesh = views.get(this)!.sceneMesh(m);
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
    views.delete(this);
    this.cache.clear();
    if (this.ownsTileset) this.tileset.dispose();
  }
}

const views=new WeakMap<Tiles3dLayer,CommittedTileView>();
/** Internal count without cloning public mesh views. */
export function preparedTileMeshCount(layer:Tiles3dLayer):number { const view=views.get(layer); pointLive(!view); return view!.meshes().length; }
