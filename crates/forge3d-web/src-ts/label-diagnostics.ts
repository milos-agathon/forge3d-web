import type { LabelDiagnostic } from "./label-types.js";
export function labelDiagnostic(
  code: string,
  details: Record<string, unknown>,
  objectId: string | null = null,
  layerId: string | null = "labels",
): LabelDiagnostic {
  const table: Record<
    string,
    [LabelDiagnostic["severity"], string, string, string]
  > = {
    experimental_feature: [
      "warning",
      "Requested workflow uses a feature that is not production-stable.",
      "Treat this path as experimental or use a documented supported alternative.",
      "experimental",
    ],
    placeholder_fallback: [
      "error",
      "Requested workflow would use placeholder or non-renderable fallback output.",
      "Use a renderable supported path or keep the workflow blocked before render.",
      "placeholder/fallback",
    ],
    missing_glyphs: [
      "warning",
      `${Number(details.count)} glyphs are missing from the active atlas.`,
      "Load an atlas with the missing glyphs or change label text before rendering.",
      "underdeveloped",
    ],
    label_rejection_summary: [
      "warning",
      `${Number(details.total)} label candidates were rejected during placement.`,
      "Inspect rejection reasons and adjust priorities, keepouts, glyph coverage, or geometry.",
      "underdeveloped",
    ],
    unicode_coverage_gap: [
      "warning",
      "Label text contains Unicode code points outside configured atlas coverage.",
      "Load an atlas or fallback range covering the missing code points before rendering.",
      "underdeveloped",
    ],
    missing_label_field: [
      "error",
      "Label text expression references a missing feature field.",
      "Provide the referenced property or change the label text expression.",
      "unsupported",
    ],
    unavailable_terrain_sampler: [
      "warning",
      "Terrain-height sampling was requested but no terrain sampler is available.",
      "Provide a terrain sampler or choose a label terrain policy that does not require sampling.",
      "underdeveloped",
    ],
    unsupported_feature: [
      "error",
      "Requested MapScene feature is not supported by the MVP workflow.",
      "Remove the feature or use a documented supported MapScene path.",
      "unsupported",
    ],
    missing_external_asset: [
      "error",
      "Scene or bundle references an external asset that cannot be found.",
      "Provide the referenced asset or update the scene/bundle to point at an available file.",
      "unsupported",
    ],
  };
  const entry = table[code];
  if (!entry) throw new Error(`Unknown label diagnostic: ${code}`);
  return {
    code,
    severity: entry[0],
    message: entry[1],
    remediation: entry[2],
    support_level: entry[3],
    layer_id: layerId,
    object_id: objectId,
    details,
  };
}
export function stableLabelJson(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sorted(value)).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export const labelCompare = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
