import { Forge3DError } from "./index.js";
import type { CrsTransformer } from "./crs.js";
import type {
  CrsCoordinate,
  CrsGeoJson,
  CrsTransformOptions,
} from "./crs-types.js";
/** All GeoJSON topology is retained. Stale bounds are recomputed, never reused. */
export async function reprojectGeoJson<T extends CrsGeoJson>(
  transformer: CrsTransformer,
  input: T,
  source: string,
  target: string,
  options: CrsTransformOptions,
): Promise<T> {
  const invalid = () => {
    throw new Forge3DError("INVALID_INPUT", "Invalid GeoJSON geometry");
  };
  let result: T;
  try {
    result = structuredClone(input);
  } catch {
    invalid();
  }
  const points: number[][] = [],
    bounded: { node: CrsGeoJson; start: number; end: number }[] = [];
  let nodes = 0;
  const coordinates = (value: unknown, depth: number): void => {
    if (!Array.isArray(value)) invalid();
    const array = value as unknown[];
    if (depth > 0) {
      for (const child of array) coordinates(child, depth - 1);
      return;
    }
    if (
      array.length < 2 ||
      array.length > 4 ||
      array.some((n) => typeof n !== "number" || !Number.isFinite(n))
    )
      invalid();
    points.push(array as number[]);
    if (points.length > transformer.maxPoints)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Geometry exceeds maxPoints",
      );
  };
  const visit = (node: CrsGeoJson, depth = 0): void => {
    if (depth > 128 || ++nodes > transformer.maxPoints * 4)
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Geometry topology budget exceeded",
      );
    if (typeof node !== "object" || node === null) invalid();
    const start = points.length;
    switch (node.type) {
      case "FeatureCollection":
        if (!Array.isArray(node.features)) invalid();
        node.features!.forEach((child) => visit(child, depth + 1));
        break;
      case "Feature":
        if (node.geometry !== null) {
          if (!node.geometry) invalid();
          visit(node.geometry!, depth + 1);
        }
        break;
      case "GeometryCollection":
        if (!Array.isArray(node.geometries)) invalid();
        node.geometries!.forEach((child) => visit(child, depth + 1));
        break;
      case "Point":
        coordinates(node.coordinates, 0);
        break;
      case "MultiPoint":
      case "LineString":
        coordinates(node.coordinates, 1);
        break;
      case "MultiLineString":
      case "Polygon":
        coordinates(node.coordinates, 2);
        break;
      case "MultiPolygon":
        coordinates(node.coordinates, 3);
        break;
      default:
        invalid();
    }
    if (node.bbox) bounded.push({ node, start, end: points.length });
  };
  visit(result!);
  // Separate tuple lengths so optional Z/T ordinates are transformed too.
  for (const stride of [2, 3, 4] as const) {
    const group = points.filter((p) => p.length === stride);
    if (!group.length) continue;
    const converted = await transformer.transformCoords(
      group as unknown as CrsCoordinate[],
      source,
      target,
      { ...options, stride, alwaysXY: true },
    );
    group.forEach((p, i) => p.splice(0, p.length, ...converted[i]!));
  }
  if (!points.length)
    await transformer.transformCoords([], source, target, options);
  for (const { node, start, end } of bounded) {
    const subset = points.slice(start, end);
    let dimensions = 4;
    if (!subset.length) {
      delete node.bbox;
      continue;
    }
    for (const p of subset) dimensions = Math.min(dimensions, p.length);
    const min = Array(dimensions).fill(Infinity) as number[],
      max = Array(dimensions).fill(-Infinity) as number[];
    for (const p of subset)
      for (let i = 0; i < dimensions; i++) {
        min[i] = Math.min(min[i]!, p[i]!);
        max[i] = Math.max(max[i]!, p[i]!);
      }
    node.bbox = [...min, ...max];
  }
  // A legacy CRS declaration must not keep describing source coordinates.
  if ("crs" in result!)
    (result! as CrsGeoJson).crs = {
      type: "name",
      properties: { name: target },
    };
  return result!;
}
