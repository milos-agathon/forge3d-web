import { Forge3DError } from "./index.js";
import type { CrsTransformer } from "./crs.js";
import type { CrsTransformOptions, CrsGeoJson } from "./crs-types.js";
import type { VectorLayerInput, VectorPosition } from "./vector-types.js";
import type { LabelFeature, LabelFeatureOptions } from "./label-features.js";
import { LabelFeatureSource } from "./label-features.js";

export type GeospatialVectorLayerInput = VectorLayerInput & { crs: string };
export type CrsLayerTarget = string | { readonly crs: string | undefined };
function targetCrs(target: CrsLayerTarget): string {
  const value = typeof target === "string" ? target : target.crs;
  if (!value)
    throw new Forge3DError(
      "INVALID_INPUT",
      "Automatic layer reprojection requires a target CRS",
    );
  return value;
}
/** Convert the horizontal X/Z map plane, preserving Y elevation and feature IDs. */
export async function reprojectVectorLayer(
  transformer: CrsTransformer,
  input: GeospatialVectorLayerInput,
  target: CrsLayerTarget,
  options: CrsTransformOptions = {},
): Promise<GeospatialVectorLayerInput> {
  const result = structuredClone(input),
    positions: VectorPosition[] = [],
    crs = targetCrs(target);
  const append = (position: VectorPosition) => {
    if (positions.length >= transformer.maxPoints)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Vector coordinate budget exceeded",
      );
    positions.push(position);
  };
  for (const feature of result.features) {
    if (feature.kind === "point") append(feature.position);
    else if (feature.kind === "line")
      for (const p of feature.positions) append(p);
    else for (const ring of feature.rings) for (const p of ring) append(p);
  }
  const points = positions.map((p) => [p[0], p[2]] as [number, number]);
  const converted = await transformer.transformCoords(points, input.crs, crs, {
    ...options,
    alwaysXY: true,
    stride: 2,
  });
  positions.forEach((p, i) => {
    p[0] = converted[i]![0]!;
    p[2] = converted[i]![1]!;
  });
  return { ...result, crs };
}
/** Asynchronous PROJ bridge for W13's synchronous label candidate recipes. */
export async function reprojectLabelFeatures(
  transformer: CrsTransformer,
  features: Iterable<LabelFeature>,
  source: string,
  target: CrsLayerTarget,
  options: LabelFeatureOptions = {},
  transformOptions: CrsTransformOptions = {},
): Promise<LabelFeatureSource> {
  const targetDefinition = targetCrs(target),
    result: LabelFeature[] = [],
    geometries: CrsGeoJson[] = [],
    assignments: Array<(geometry: CrsGeoJson) => void> = [];
  for (const feature of features) {
    if (result.length >= 10000)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Label feature budget exceeded",
      );
    const copy = structuredClone(feature);
    if (
      copy.geometry &&
      typeof copy.geometry === "object" &&
      typeof copy.geometry.type === "string"
    ) {
      geometries.push({ ...copy.geometry, type: copy.geometry.type });
      assignments.push((g) => {
        copy.geometry = g;
      });
    } else if (!copy.geometry) {
      const type = copy.geometry_type || copy.type;
      const key = ["coordinates", "position", "world_pos"].find((k) =>
        Array.isArray(copy[k]) ? (copy[k] as unknown[]).length > 0 : !!copy[k],
      );
      if (type && key) {
        geometries.push({ type: String(type), coordinates: copy[key] });
        assignments.push((g) => {
          copy[key] = g.coordinates;
        });
      }
    }
    result.push(copy);
  }
  const converted = await transformer.reprojectGeometry(
    { type: "GeometryCollection", geometries },
    source,
    targetDefinition,
    transformOptions,
  );
  converted.geometries!.forEach((geometry, i) => assignments[i]!(geometry));
  return LabelFeatureSource.fromFeatures(result, {
    ...options,
    crs: targetDefinition,
    targetCrs: targetDefinition,
    metadata: { ...options.metadata, source_crs: source },
  });
}
