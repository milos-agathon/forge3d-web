import { Forge3DError } from "./index.js";
import type {
  BrowserByteSource,
  ByteReadOptions,
  Forge3DScene,
} from "./index.js";
import { readByteSource } from "./browser-io.js";
import { extrudePolygon } from "./geometry.js";
import {
  checkMesh,
  cloneMesh,
  meshBytes,
  meshBounds,
  meshError,
  meshLimit,
  meshNumber,
  meshInteger,
  recomputeMeshNormals,
  MESH_IDENTITY,
} from "./mesh.js";
import type { MeshBuffers, MeshInput, MeshBounds, Vec3 } from "./mesh.js";
import { transformMesh, generateMeshLods } from "./mesh-processing.js";
import {
  buildingMaterialFromTags,
  inferRoofType,
  normalizeBuildingMaterial,
} from "./building-materials.js";
import type { BuildingMaterial, RoofType } from "./building-materials.js";
import { diagnoseBuildingTextures } from "./building-diagnostics.js";
import type {
  BuildingTextureRequest,
  BuildingTextureReport,
} from "./building-diagnostics.js";
import { TerrainScatterBatch } from "./terrain-scatter.js";
import type { GltfAsset } from "./mesh-gltf.js";
import type { CrsTransformer } from "./crs.js";
import type { CrsGeoJson } from "./crs-types.js";
import { triangulateVectorPolygon } from "./vector-geometry.js";
export interface BuildingInput {
  id: string;
  mesh: MeshInput;
  height?: number | null;
  groundHeight?: number | null;
  roofType?: RoofType;
  material?: Partial<BuildingMaterial>;
  lod?: number;
  attributes?: Readonly<Record<string, unknown>>;
}
export interface BuildingRecord {
  id: string;
  mesh: MeshBuffers;
  height: number | null;
  groundHeight: number | null;
  roofType: RoofType;
  material: BuildingMaterial;
  lod: number;
  attributes: Record<string, unknown>;
}
export interface BuildingLayerOptions {
  name?: string;
  crs?: string;
  textures?: readonly BuildingTextureRequest[];
  proGated?: boolean;
}
export interface BuildingLoadOptions
  extends ByteReadOptions,
    BuildingLayerOptions {
  format?: "geojson" | "cityjson";
  defaultHeight?: number;
  heightKey?: string;
  origin?: Vec3;
  transformer?: CrsTransformer;
  targetCrs?: string;
}
function object(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    meshError(`${name} must be an object`);
  return v as Record<string, unknown>;
}
function array(v: unknown, name: string): unknown[] {
  if (!Array.isArray(v)) meshError(`${name} must be an array`);
  return v;
}
function number(v: unknown, name: string): number {
  if (typeof v !== "number") meshError(`${name} must be a number`);
  return meshNumber(v, name);
}
function coord(v: unknown): [number, number, number] {
  const a = array(v, "coordinate");
  if (a.length < 2) meshError("coordinate needs two components");
  return [
    number(a[0], "x"),
    number(a[1], "y"),
    a.length > 2 ? number(a[2], "z") : 0,
  ];
}
function optionalHeight(
  attributes: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = attributes[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}
/** Geometry stays in its source Z-up axes; rendering rotates it to browser Y-up. */
export class BuildingLayer {
  readonly name: string;
  readonly crs: string | undefined;
  #buildings: BuildingRecord[] | null;
  #textures: BuildingTextureRequest[];
  #pro: boolean;
  constructor(
    buildings: readonly BuildingInput[],
    options: BuildingLayerOptions = {},
  ) {
    this.name = options.name ?? "buildings";
    this.crs = options.crs;
    this.#pro = options.proGated ?? false;
    this.#textures = structuredClone([...(options.textures ?? [])]);
    const ids = new Set<string>();
    let bytes = 0;
    this.#buildings = buildings.map((b) => {
      if (!b.id || ids.has(b.id))
        meshError("building IDs must be nonempty and unique");
      ids.add(b.id);
      checkMesh(b.mesh);
      bytes += b.mesh.normals?.length
        ? meshBytes(b.mesh)
        : b.mesh.positions.byteLength * 2 +
          b.mesh.indices.byteLength +
          (b.mesh.uvs?.byteLength ?? 0);
      meshLimit(bytes);
      const lod = meshNumber(b.lod ?? 1, "LOD", 0, 4);
      return {
        id: b.id,
        mesh: b.mesh.normals?.length
          ? cloneMesh(b.mesh)
          : recomputeMeshNormals(b.mesh),
        height:
          b.height == null ? null : meshNumber(b.height, "building height"),
        groundHeight:
          b.groundHeight == null
            ? null
            : meshNumber(b.groundHeight, "building ground height"),
        roofType: b.roofType ?? "flat",
        material: normalizeBuildingMaterial(b.material),
        lod,
        attributes: structuredClone(b.attributes ?? {}),
      };
    });
  }
  get disposed(): boolean {
    return this.#buildings === null;
  }
  #live(): BuildingRecord[] {
    if (this.#buildings === null)
      throw new Forge3DError("RUNTIME_DISPOSED", "Building layer disposed");
    return this.#buildings;
  }
  get buildingCount(): number {
    return this.#live().length;
  }
  get totalVertices(): number {
    return this.#live().reduce((n, b) => n + b.mesh.positions.length / 3, 0);
  }
  get totalTriangles(): number {
    return this.#live().reduce((n, b) => n + b.mesh.indices.length / 3, 0);
  }
  get maxLod(): number {
    return this.#live().reduce((n, b) => Math.max(n, b.lod), 0);
  }
  get cpuBytes(): number {
    return this.#buildings?.reduce((n, b) => n + meshBytes(b.mesh), 0) ?? 0;
  }
  buildings(): BuildingRecord[] {
    return structuredClone(this.#live());
  }
  bounds(): MeshBounds | null {
    let result: MeshBounds | null = null;
    for (const building of this.#live()) {
      const bounds = meshBounds(building.mesh);
      if (!bounds) continue;
      if (!result) result = bounds;
      else
        for (let a = 0; a < 3; a++) {
          result.min[a] = Math.min(result.min[a]!, bounds.min[a]!);
          result.max[a] = Math.max(result.max[a]!, bounds.max[a]!);
        }
    }
    return result;
  }
  validate(): BuildingTextureReport {
    const live = this.#live(),
      report = diagnoseBuildingTextures(this.#textures, this.#pro);
    if (!live.some((b) => b.mesh.indices.length)) {
      report.status = "error";
      report.supportLevel = "placeholder/fallback";
      report.unsupportedFeatures["buildings.geometry"] = "placeholder/fallback";
      report.diagnostics.push({
        code: "placeholder_fallback",
        objectId: null,
        severity: "error",
        details: { feature: "building geometry", geometry_count: 0 },
      });
    }
    return report;
  }

  /** Uses scene scalar BRDF materials, shared instancing, LOD and resource ownership. */
  addToScene(
    scene: Forge3DScene,
    options: {
      lodRatios?: readonly number[];
      lodDistances?: readonly number[];
      transforms?: Float32Array;
    } = {},
  ): void {
    if (this.validate().status === "error")
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "building rendering blocked by diagnostics",
        { report: this.validate() },
      );
    const ratios = options.lodRatios ?? [1],
      distances = options.lodDistances ?? [];
    if (distances.length !== ratios.length - 1)
      meshError("LOD distances need one fewer entry than ratios");
    const live = this.#live(),
      batches = scene.getScatterBatches(),
      staged = scene.copy();
    try {
      const names = new Set(live.map((b) => `${this.name}:${b.id}`));
      const retained = batches.filter((b) => !names.has(b.name ?? ""));
      if (retained.length + live.length > 256)
        throw new Forge3DError(
          "RESOURCE_LIMIT_EXCEEDED",
          "building scene exceeds 256 batches",
        );
      for (const b of live) {
        const slot = `${this.name}:${b.id}`;
        staged.setMaterial(slot, {
          id: slot,
          baseColor: [...b.material.albedo, 1],
          roughness: b.material.roughness,
          metallic: b.material.metallic,
        });
      }
      const materials = staged.getMaterials();
      const prepared = live.map((b) => {
        const slot = `${this.name}:${b.id}`,
          materialIndex = materials.find((m) => m.slot === slot)!.index,
          world = transformMesh(
            b.mesh,
            [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
          ),
          lods = generateMeshLods(world, ratios);
        return new TerrainScatterBatch({
          name: slot,
          levels: lods.map((mesh, j) =>
            j < lods.length - 1
              ? { mesh, maxDistance: distances[j]! }
              : { mesh },
          ),
          transforms: options.transforms ?? MESH_IDENTITY,
          materialIndex,
          color: [1, 1, 1, 1],
        });
      });
      staged.setScatterBatches([...retained, ...prepared]);
      // All geometry and allocations are validated before committing scene state.
      for (const b of live) {
        const slot = `${this.name}:${b.id}`;
        scene.setMaterial(slot, {
          id: slot,
          baseColor: [...b.material.albedo, 1],
          roughness: b.material.roughness,
          metallic: b.material.metallic,
        });
      }
      scene.setScatterBatches(staged.getScatterBatches());
    } finally {
      staged.dispose();
    }
  }
  dispose(): void {
    this.#buildings = null;
    this.#textures = [];
  }
  static fromGltf(
    asset: GltfAsset,
    options: BuildingLayerOptions = {},
  ): BuildingLayer {
    const textures: BuildingTextureRequest[] = [...(options.textures ?? [])];
    return new BuildingLayer(
      asset.primitives.map((p, i) => {
        const material =
            p.material === null ? {} : (asset.materials[p.material] ?? {}),
          pbr =
            material.pbrMetallicRoughness === undefined
              ? {}
              : object(material.pbrMetallicRoughness, "PBR material"),
          color = Array.isArray(pbr.baseColorFactor)
            ? (pbr.baseColorFactor.slice(0, 3) as [number, number, number])
            : ([1, 1, 1] as [number, number, number]);
        for (const key of ["baseColorTexture", "metallicRoughnessTexture"])
          if (pbr[key] !== undefined)
            textures.push({
              materialId: `material-${p.material}:${key}`,
              objectId: `${p.name}:${i}`,
              albedoTexture: `gltf-texture:${key}`,
              uvAvailable: !!p.mesh.uvs.length,
              assetAvailable: true,
            });
        for (const key of [
          "normalTexture",
          "occlusionTexture",
          "emissiveTexture",
        ])
          if (material[key] !== undefined)
            textures.push({
              materialId: `material-${p.material}:${key}`,
              objectId: `${p.name}:${i}`,
              albedoTexture: `gltf-texture:${key}`,
              uvAvailable: !!p.mesh.uvs.length,
              assetAvailable: true,
            });
        // glTF Y-up converts to the BuildingLayer source Z-up contract.
        return {
          id: `${p.name}:${i}`,
          mesh: transformMesh(
            p.mesh,
            [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
          ),
          material: {
            albedo: color,
            roughness:
              typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1,
            metallic:
              typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1,
          },
        };
      }),
      { ...options, textures },
    );
  }
}
export function parseGeoJsonBuildings(
  value: unknown,
  o: BuildingLoadOptions = {},
): BuildingLayer {
  const root = object(value, "GeoJSON");
  if (root.type !== "FeatureCollection")
    meshError("buildings require a FeatureCollection");
  const origin = o.origin ?? [0, 0, 0],
    defaultHeight = meshNumber(
      o.defaultHeight ?? 10,
      "defaultHeight",
      Number.MIN_VALUE,
    ),
    buildings: BuildingInput[] = [];
  for (const [i, entry] of array(root.features, "features").entries()) {
    const f = object(entry, "feature"),
      props =
        f.properties === null || f.properties === undefined
          ? {}
          : object(f.properties, "properties");
    if (!f.geometry) continue;
    const g = object(f.geometry, "geometry");
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") continue;
    const raw = array(g.coordinates, "coordinates"),
      polygons = g.type === "Polygon" ? [raw] : raw;
    let height = defaultHeight;
    const v = props[o.heightKey ?? "height"];
    if (typeof v === "number" || typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n) && n !== 0) height = n;
    } else if (typeof props["building:levels"] === "number")
      height =
        meshNumber(props["building:levels"], "levels", Number.MIN_VALUE) * 3;
    for (const [j, poly] of polygons.entries()) {
      const rings = array(poly, "polygon").map((r) =>
        array(r, "ring").map((v) => {
          const p = coord(v);
          return [p[0] - origin[0], p[1] - origin[1]] as [number, number];
        }),
      );
      const ground = optionalHeight(props, ["min_height", "groundHeight"]) ?? 0;
      const mesh = extrudePolygon(rings, {
        height,
        baseHeight: ground - origin[2],
      });
      const id =
        String(f.id ?? props.id ?? `building_${i}`) +
        (polygons.length > 1 ? `:${j}` : "");
      buildings.push({
        id,
        mesh,
        height,
        groundHeight: ground,
        roofType: inferRoofType(props),
        material: buildingMaterialFromTags(props),
        attributes: props,
        lod: 1,
      });
    }
  }
  return new BuildingLayer(buildings, o);
}
/** Shared MultiPolygonZ surface decoder used by CityJSON and public geometry IO. */
export function meshFromMultiPolygonZ(
  polygons: readonly (readonly (readonly Vec3[])[])[],
): MeshBuffers {
  const positions: number[] = [],
    indices: number[] = [];
  for (const rings of polygons) {
    if (!rings.length) continue;
    const outer = rings[0]!;
    if (outer.length < 3) meshError("surface ring too short");
    const origin = outer[0]!,
      u = outer[1]!.map((x, i) => x - origin[i]!) as [number, number, number];
    let normal: [number, number, number] = [0, 0, 0];
    for (let i = 1; i < outer.length - 1; i++) {
      const v = outer[i + 1]!.map((x, j) => x - origin[j]!) as [
        number,
        number,
        number,
      ];
      normal = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ];
      if (Math.hypot(...normal) > 1e-8) break;
    }
    if (!Math.hypot(...normal)) meshError("degenerate surface");
    const drop = normal
        .map(Math.abs)
        .indexOf(Math.max(...normal.map(Math.abs))),
      axes = [0, 1, 2].filter((a) => a !== drop);
    const projected = rings.map((r) =>
        r.map((p) => {
          p.forEach((x) => meshNumber(x, "surface coordinate"));
          return [p[axes[0]!]!, 0, p[axes[1]!]!] as [number, number, number];
        }),
      ),
      base = positions.length / 3,
      ids = new Map<string, number>();
    for (const ring of rings)
      for (const p of ring) {
        const key = `${p[axes[0]!]},${p[axes[1]!]}`;
        if (!ids.has(key)) {
          ids.set(key, positions.length / 3);
          positions.push(...p);
        }
      }
    const triangles = triangulateVectorPolygon(projected);
    for (const t of triangles) {
      let tri = t.map((p) => ids.get(`${p[0]},${p[2]}`)!);
      const signed = (axes[0] === 0 && axes[1] === 2 ? -1 : 1) * normal[drop]!;
      if (signed < 0) tri = [tri[0]!, tri[2]!, tri[1]!];
      indices.push(...tri);
    }
    if (positions.length / 3 === base) meshError("surface is empty");
    meshLimit((positions.length * 2 + indices.length) * 4);
  }
  return recomputeMeshNormals({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  });
}
export function parseCityJsonBuildings(
  value: unknown,
  o: BuildingLoadOptions = {},
): BuildingLayer {
  const root = object(value, "CityJSON");
  if (root.type !== "CityJSON") meshError("not a CityJSON document");
  const tr =
      root.transform === undefined ? {} : object(root.transform, "transform"),
    scale = tr.scale === undefined ? [1, 1, 1] : coord(tr.scale),
    translate = tr.translate === undefined ? [0, 0, 0] : coord(tr.translate),
    origin = o.origin ?? [0, 0, 0];
  meshLimit(array(root.vertices, "vertices").length * 24);
  const vertices = array(root.vertices, "vertices").map((v) => {
      const p = coord(v);
      return p.map((x, i) => x * scale[i]! + translate[i]! - origin[i]!) as [
        number,
        number,
        number,
      ];
    }),
    buildings: BuildingInput[] = [],
    textures: BuildingTextureRequest[] = [...(o.textures ?? [])];
  for (const [id, value] of Object.entries(
    object(root.CityObjects, "CityObjects"),
  )) {
    const obj = object(value, "CityObject");
    if (obj.type !== "Building" && obj.type !== "BuildingPart") continue;
    const attrs =
        obj.attributes === undefined
          ? {}
          : object(obj.attributes, "attributes"),
      geoms =
        obj.geometry === undefined
          ? []
          : array(obj.geometry, "geometry").map((g) => object(g, "geometry"));
    if (!geoms.length) continue;
    let selected: Record<string, unknown> | undefined,
      lod = -1;
    for (const g of geoms) {
      const l = Number(g.lod ?? 1);
      if (Number.isFinite(l) && l >= lod) {
        selected = g;
        lod = l;
      }
    }
    if (!selected) meshError("no valid CityJSON LOD");
    const g = selected,
      raw = array(g.boundaries, "boundaries");
    let surfaces: unknown[];
    if (g.type === "Solid")
      surfaces = raw.flatMap((shell) => array(shell, "shell"));
    else if (g.type === "MultiSurface" || g.type === "CompositeSurface")
      surfaces = raw;
    else
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        `CityJSON geometry ${String(g.type)} unsupported`,
      );
    const polygons = surfaces.map((surface) =>
      array(surface, "surface").map((ring) =>
        array(ring, "ring").map((v) => {
          const index = meshInteger(
            number(v, "vertex index"),
            "vertex index",
            0,
            vertices.length - 1,
          );
          return vertices[index]!;
        }),
      ),
    );
    const mesh = meshFromMultiPolygonZ(polygons);
    if (!mesh.indices.length) continue;
    buildings.push({
      id,
      mesh,
      height: optionalHeight(attrs, [
        "measuredHeight",
        "height",
        "h_dak",
        "h_max",
      ]),
      groundHeight: optionalHeight(attrs, [
        "groundHeight",
        "h_maaiveld",
        "h_min",
      ]),
      roofType: inferRoofType(attrs),
      material: buildingMaterialFromTags(attrs),
      lod: Math.floor(lod),
      attributes: attrs,
    });
    if (g.texture !== undefined) {
      const appearance =
        root.appearance === undefined
          ? {}
          : object(root.appearance, "appearance");
      const assets = array(appearance.textures ?? [], "textures");
      if (!assets.length)
        textures.push({
          materialId: "missing-texture",
          objectId: id,
          uvAvailable: false,
          assetAvailable: false,
        });
      for (const [i, t] of assets.entries()) {
        const texture = object(t, "texture");
        textures.push({
          materialId: `texture-${i}`,
          objectId: id,
          albedoTexture: String(texture.image ?? ""),
          uvAvailable: Array.isArray(appearance["vertices-texture"]),
          assetAvailable: false,
        });
      }
    }
  }
  const meta =
      root.metadata === undefined ? {} : object(root.metadata, "metadata"),
    ref =
      typeof meta.referenceSystem === "string"
        ? meta.referenceSystem
        : undefined;
  let crs = o.crs;
  if (!crs && ref) {
    const match = /(\d+)$/.exec(ref);
    if (match) crs = `EPSG:${match[1]}`;
  }
  return new BuildingLayer(buildings, {
    ...o,
    textures,
    ...(crs ? { crs } : {}),
  });
}
export async function loadBuildings(
  source: BrowserByteSource,
  o: BuildingLoadOptions = {},
): Promise<BuildingLayer> {
  const bytes = await readByteSource(source, o);
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    meshError("malformed building JSON");
  }
  const format =
    o.format ??
    (object(root, "building document").type === "CityJSON"
      ? "cityjson"
      : "geojson");
  if (o.targetCrs && o.targetCrs !== o.crs) {
    if (!o.transformer || !o.crs)
      meshError("building reprojection needs source CRS and transformer");
    if (format === "cityjson") {
      const doc = object(root, "CityJSON"),
        tr =
          doc.transform === undefined ? {} : object(doc.transform, "transform"),
        scale = tr.scale === undefined ? [1, 1, 1] : coord(tr.scale),
        translate =
          tr.translate === undefined ? [0, 0, 0] : coord(tr.translate);
      const points = array(doc.vertices, "vertices").map(
        (v) =>
          coord(v).map((x, i) => x * scale[i]! + translate[i]!) as [
            number,
            number,
            number,
          ],
      );
      doc.vertices = await o.transformer.transformCoords(
        points,
        o.crs,
        o.targetCrs,
        { ...(o.signal ? { signal: o.signal } : {}), alwaysXY: true },
      );
      delete doc.transform;
    } else
      root = await o.transformer.reprojectGeometry(
        root as CrsGeoJson,
        o.crs,
        o.targetCrs,
        { ...(o.signal ? { signal: o.signal } : {}), alwaysXY: true },
      );
  }
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "building load cancelled");
  const opts = { ...o, ...(o.targetCrs ? { crs: o.targetCrs } : {}) };
  return format === "cityjson"
    ? parseCityJsonBuildings(root, opts)
    : parseGeoJsonBuildings(root, opts);
}
/** Native public 3D Tiles building metadata was explicitly incomplete. W16 owns traversal. */
export async function loadBuildingTilesMetadata(
  source: BrowserByteSource,
  o: ByteReadOptions = {},
): Promise<{
  tileset: Record<string, unknown>;
  status: "underdeveloped";
  diagnostics: {
    code: "python_public_3dtiles_incomplete";
    severity: "error";
  }[];
}> {
  const bytes = await readByteSource(source, o);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    meshError("malformed tileset JSON");
  }
  const tileset = object(doc, "tileset");
  object(tileset.root, "tileset.root");
  return {
    tileset,
    status: "underdeveloped",
    diagnostics: [
      { code: "python_public_3dtiles_incomplete", severity: "error" },
    ],
  };
}
