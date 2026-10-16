import { labelCase } from "./label-cases.js";
import { LabelPlan } from "./label-plan.js";
import { labelCompare, labelDiagnostic } from "./label-diagnostics.js";
import { labelCoordinates } from "./label-candidates.js";
import type {
  LabelDiagnostic,
  LabelRecord,
  LabelPlanOptions,
  LabelTerrainSampler,
} from "./label-types.js";
export interface LabelFeature {
  id?: string | number;
  feature_id?: string;
  source_id?: string;
  type?: string;
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown } | null;
  [key: string]: unknown;
}
export interface LabelFeatureOptions {
  text?: unknown;
  crs?: string;
  targetCrs?: string;
  terrainSampling?: "auto" | "required" | "flat";
  terrainSampler?: LabelTerrainSampler;
  layerId?: string;
  metadata?: Record<string, unknown>;
  typography?: Record<string, unknown>;
  glyphAtlas?: LabelPlanOptions["glyph_atlas"];
  /** W14 can supply PROJ here. A different CRS always requires a real transform. */
  transformCoords?: (
    coordinates: readonly (readonly number[])[],
    fromCrs: string,
    toCrs: string,
  ) => readonly (readonly number[])[];
}
// Feature ingestion checks only x/y, as native _is_coordinate does. The
// compiler separately validates elevation and every remaining coordinate.
function featureCoordinate(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value
      .slice(0, 2)
      .every(
        (v) =>
          (typeof v === "number" ||
            typeof v === "boolean" ||
            (typeof v === "string" && v.trim() !== "")) &&
          !Number.isNaN(Number(v)),
      )
  );
}
function nativeTruthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : !!value;
}
function nativeText(value: unknown): string {
  return value == null
    ? "None"
    : typeof value === "boolean"
      ? value
        ? "True"
        : "False"
      : String(value);
}
function sameCrs(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
function expressionText(
  expression: unknown,
  props: Record<string, unknown>,
): [string, string | null] {
  if (expression == null) expression = "name";
  if (typeof expression === "string") {
    const template = /^\{([^{}]+)\}$/.exec(expression);
    if (template)
      return template[1]! in props
        ? [nativeText(props[template[1]!]), null]
        : ["", template[1]!];
    return [
      expression in props ? nativeText(props[expression]) : expression,
      null,
    ];
  }
  const evaluate = (e: unknown): unknown => {
    if (!Array.isArray(e)) return e;
    const [op, ...args] = e;
    switch (op) {
      case "literal":
        return args[0];
      case "get":
        return props[String(args[0])] ?? null;
      case "concat":
        return args.map((a) => evaluate(a) ?? "").join("");
      case "coalesce":
        return args.map(evaluate).find((v) => v != null) ?? null;
      case "upcase":
        return String(evaluate(args[0]) ?? "").toUpperCase();
      case "downcase":
        return String(evaluate(args[0]) ?? "").toLowerCase();
      default:
        throw Error("Unsupported expression");
    }
  };
  try {
    const value = evaluate(expression);
    return value == null
      ? ["", String(Array.isArray(expression) ? expression[1] : expression)]
      : [String(value), null];
  } catch {
    return ["", JSON.stringify(expression)];
  }
}
/** Native label feature recipe, separate from the live GPU layer. Native plans
 * use [map x,map y,elevation]. World rendering uses [world x,world y,world z]. */
export class LabelFeatureSource {
  readonly labels: LabelRecord[];
  readonly diagnostics: LabelDiagnostic[];
  readonly metadata: Record<string, unknown>;
  readonly layerId: string;
  readonly typography: Record<string, unknown>;
  readonly glyphAtlas: LabelPlanOptions["glyph_atlas"];
  private constructor(
    labels: LabelRecord[],
    diagnostics: LabelDiagnostic[],
    options: LabelFeatureOptions,
  ) {
    this.labels = labels;
    this.diagnostics = diagnostics;
    this.metadata = structuredClone(options.metadata ?? {});
    this.layerId = options.layerId ?? "labels";
    this.typography = structuredClone(options.typography ?? {});
    this.glyphAtlas = options.glyphAtlas;
    if (options.crs) {
      this.metadata.crs = options.targetCrs ?? options.crs;
      if (options.targetCrs && !sameCrs(options.targetCrs, options.crs))
        this.metadata.source_crs = options.crs;
    }
    this.metadata.terrain_sampling = options.terrainSampling ?? "auto";
  }
  static fromFeatures(
    features: Iterable<LabelFeature>,
    options: LabelFeatureOptions = {},
  ): LabelFeatureSource {
    const labels: LabelRecord[] = [],
      diagnostics: LabelDiagnostic[] = [],
      layerId = options.layerId ?? "labels";
    let index = 0;
    for (const feature of features) {
      if (index >= 10000) throw Error("Label feature budget exceeded");
      const id = String(
        feature.id ||
          feature.feature_id ||
          feature.source_id ||
          `feature-${index}`,
      );
      index++;
      const flatType = [feature.geometry_type, feature.type].find(nativeTruthy);
      const flatCoordinates = [
        feature.coordinates,
        feature.position,
        feature.world_pos,
      ].find(nativeTruthy);
      const g = structuredClone(
          feature.geometry && typeof feature.geometry === "object"
            ? feature.geometry
            : flatType && flatCoordinates !== undefined
              ? { type: String(flatType), coordinates: flatCoordinates }
              : {},
        ),
        kind = (g.type ?? "").toLowerCase();
      const valid =
        kind === "point"
          ? featureCoordinate(g.coordinates)
          : kind === "linestring"
            ? Array.isArray(g.coordinates) &&
              g.coordinates.length >= 2 &&
              g.coordinates.every(featureCoordinate)
            : kind === "polygon"
              ? Array.isArray(g.coordinates) &&
                Array.isArray(g.coordinates[0]) &&
                g.coordinates[0].length >= 4 &&
                g.coordinates[0].every(featureCoordinate)
              : !!g.type;
      if (!valid) {
        diagnostics.push(
          labelDiagnostic(
            "placeholder_fallback",
            { feature: "label invalid geometry" },
            id,
            layerId,
          ),
        );
        continue;
      }
      if (!["point", "linestring", "polygon"].includes(kind)) {
        diagnostics.push(
          labelDiagnostic(
            "unsupported_feature",
            { feature: `label geometry type ${g.type}` },
            id,
            layerId,
          ),
        );
        continue;
      }
      if (
        options.crs &&
        options.targetCrs &&
        !sameCrs(options.crs, options.targetCrs)
      ) {
        if (!options.transformCoords)
          throw Error("Label CRS conversion requires transformCoords");
        const transform = (points: number[][]) => {
          const xy = options.transformCoords!(
            points.map((p) => p.slice(0, 2)),
            options.crs!,
            options.targetCrs!,
          );
          if (
            xy.length !== points.length ||
            xy.some((p) => !labelCoordinates(p))
          )
            throw Error("Invalid label CRS transform result");
          return points.map((p, i) => [
            xy[i]![0]!,
            xy[i]![1]!,
            ...p.slice(2, 3),
          ]);
        };
        g.coordinates =
          kind === "point"
            ? transform([g.coordinates as number[]])[0]
            : kind === "linestring"
              ? transform(g.coordinates as number[][])
              : (g.coordinates as number[][][]).map(transform);
      }
      const properties = structuredClone(
          feature.properties ??
            Object.fromEntries(
              Object.entries(feature).filter(
                ([k]) => !["geometry", "coordinates", "type"].includes(k),
              ),
            ),
        ),
        [text, missing] = expressionText(options.text, properties);
      if (missing !== null) {
        diagnostics.push(
          labelDiagnostic(
            "missing_label_field",
            { field: missing },
            id,
            layerId,
          ),
        );
        continue;
      }
      let sample: Record<string, unknown> | undefined;
      if (options.terrainSampling === "required") {
        if (!options.terrainSampler)
          diagnostics.push(
            labelDiagnostic(
              labelCase("feature-missing-terrain").code!,
              {},
              id,
              layerId,
            ),
          );
        else if (kind === "point") {
          const p = labelCoordinates(g.coordinates);
          if (!p) throw Error("Invalid label terrain coordinates");
          const value = options.terrainSampler.sample(...p);
          sample =
            typeof value === "number"
              ? { elevation: value, source: "terrain_sampler", visible: true }
              : value && typeof value === "object"
                ? structuredClone(value)
                : {};
          if (sample.elevation !== undefined) {
            if (!Number.isFinite(sample.elevation))
              throw Error("Invalid terrain elevation");
            g.coordinates = [p[0], p[1], Number(sample.elevation)];
          }
        }
      }
      labels.push({
        id,
        source_id: id,
        text,
        geometry: {
          type:
            kind === "point"
              ? "Point"
              : kind === "linestring"
                ? "LineString"
                : "Polygon",
          coordinates: g.coordinates,
        },
        geometry_type:
          kind === "point"
            ? "Point"
            : kind === "linestring"
              ? "LineString"
              : "Polygon",
        placement_kind:
          kind === "point"
            ? "point"
            : kind === "linestring"
              ? "line"
              : "polygon",
        properties,
        terrain_mode: options.terrainSampling ?? "auto",
        ...(sample && Object.keys(sample).length
          ? { terrain_sample: sample }
          : {}),
      });
    }
    labels.sort(
      (a, b) =>
        labelCompare(String(a.id), String(b.id)) ||
        labelCompare(String(a.geometry_type), String(b.geometry_type)) ||
        labelCompare(a.text ?? "", b.text ?? ""),
    );
    return new LabelFeatureSource(labels, diagnostics, options);
  }
  static fromRows(
    rows: Iterable<{
      id: string | number;
      properties: Record<string, unknown>;
      geometry: LabelFeature["geometry"];
    }>,
    options: LabelFeatureOptions = {},
  ): LabelFeatureSource {
    return this.fromFeatures(
      Array.from(rows, (r) => ({
        id: r.id,
        properties: r.properties,
        ...(r.geometry ? { geometry: r.geometry } : {}),
      })),
      options,
    );
  }
  static fromStyleLayer(
    features: Iterable<LabelFeature>,
    style: {
      layout?: { "text-field"?: unknown };
      text?: unknown;
      text_field?: unknown;
    },
    options: LabelFeatureOptions = {},
  ): LabelFeatureSource {
    return this.fromFeatures(features, {
      ...options,
      text:
        style.layout?.["text-field"] ??
        style.text ??
        style.text_field ??
        "name",
    });
  }
  compileLabels(options: Omit<LabelPlanOptions, "labels">): LabelPlan {
    const glyphs = options.glyph_atlas ?? this.glyphAtlas;
    return LabelPlan.compile({
      ...options,
      labels: this.labels,
      typography: options.typography ?? this.typography,
      ...(glyphs ? { glyph_atlas: glyphs } : {}),
      seed: options.seed ?? Number(this.metadata.seed ?? 0),
    });
  }
  validate(options: Omit<LabelPlanOptions, "labels">): {
    plan: LabelPlan;
    diagnostics: LabelDiagnostic[];
    summary: {
      layer_id: string;
      support_level: string;
      compiled_label_plan: {
        accepted_count: number;
        rejected_count: number;
        seed: number;
      };
    };
  } {
    const plan = this.compileLabels(options),
      diagnostics = [
        ...this.diagnostics,
        ...plan.diagnostics.map((d) => ({ ...d, layer_id: this.layerId })),
      ];
    for (const r of this.labels)
      if (
        r.geometry_type === "LineString" &&
        r.repeat_distance === undefined &&
        !["road", "river", "line"].includes(
          (r.placement_preset ?? "").toLowerCase(),
        )
      )
        diagnostics.push(
          labelDiagnostic(
            "experimental_feature",
            { feature: labelCase("feature-line-unconfigured").feature },
            String(r.id),
            this.layerId,
          ),
        );
    return {
      plan,
      diagnostics,
      summary: {
        layer_id: this.layerId,
        support_level: "supported",
        compiled_label_plan: {
          accepted_count: plan.accepted.length,
          rejected_count: plan.rejected.length,
          seed: plan.toJSON().seed,
        },
      },
    };
  }
  toJSON(): Record<string, unknown> {
    return {
      kind: "label_layer",
      layer_id: this.layerId,
      labels: structuredClone(this.labels),
      glyph_atlas: structuredClone(this.glyphAtlas ?? {}),
      typography: structuredClone(this.typography),
      priority_rules: [],
      plan: null,
      metadata: structuredClone(this.metadata),
      diagnostics: structuredClone(this.diagnostics),
    };
  }
}
