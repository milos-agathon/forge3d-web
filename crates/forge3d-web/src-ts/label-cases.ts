// Generated from docs/parity/label-case-contract.json. Do not edit by hand.
import type { LabelRejectionReason } from "./label-types.js";
export const LABEL_CASES = [
  {
    id: "viewer-curved",
    outcome: "diagnostic",
    code: "experimental_feature",
    feature: "curved labels",
    reason: "unsupported_geometry_type",
  },
  {
    id: "plan-curved",
    outcome: "diagnostic",
    code: "experimental_feature",
    feature: "advanced curved labels",
    reason: "unsupported_geometry_type",
  },
  {
    id: "viewer-terrain-line",
    outcome: "diagnostic",
    code: "experimental_feature",
    feature: "terrain-elevated line labels",
    reason: "unsupported_geometry_type",
  },
  {
    id: "plan-complex-unshaped",
    outcome: "diagnostic",
    code: "experimental_feature",
    feature: "complex-script shaping",
    reason: "unsupported_geometry_type",
  },
  {
    id: "plan-flat-unconfigured",
    outcome: "diagnostic",
    reason: "unsupported_geometry_type",
  },
  {
    id: "plan-missing-terrain",
    outcome: "diagnostic",
    code: "placeholder_fallback",
    feature: "terrain_sampler",
    reason: "terrain_occluded",
  },
  {
    id: "plan-hidden-terrain",
    outcome: "diagnostic",
    reason: "terrain_occluded",
  },
  {
    id: "plan-repeat",
    outcome: "render",
  },
  {
    id: "viewer-repeat",
    outcome: "render",
  },
  {
    id: "plan-flat-preset",
    outcome: "render",
  },
  {
    id: "viewer-flat-line",
    outcome: "render",
  },
  {
    id: "plan-terrain-point",
    outcome: "render",
  },
  {
    id: "viewer-terrain-point",
    outcome: "render",
  },
  {
    id: "complex-shaped",
    outcome: "render",
    requires: "Prepared HarfBuzz FontAtlas with complete script coverage",
  },
  {
    id: "point",
    outcome: "render",
  },
  {
    id: "polygon",
    outcome: "render",
  },
  {
    id: "callout",
    outcome: "render",
  },
  {
    id: "plan-terrain-line",
    outcome: "diagnostic",
    code: "experimental_feature",
    feature: "terrain-elevated line labels",
    reason: "unsupported_geometry_type",
  },
  {
    id: "feature-line-unconfigured",
    outcome: "diagnostic",
    code: "experimental_feature",
    feature: "line labels",
    reason: "unsupported_geometry_type",
  },
  {
    id: "feature-missing-terrain",
    outcome: "diagnostic",
    code: "unavailable_terrain_sampler",
    reason: "terrain_occluded",
  },
] as const;
export function labelCase(id: string): {
  id: string;
  outcome: string;
  code?: string;
  feature?: string;
  reason?: LabelRejectionReason;
} {
  const c = LABEL_CASES.find((c) => c.id === id);
  if (!c) throw Error("Unclassified label case: " + id);
  return c;
}
