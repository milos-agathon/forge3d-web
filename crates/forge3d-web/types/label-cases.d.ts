import type { LabelRejectionReason } from "./label-types.js";
export declare const LABEL_CASES: readonly [{
    readonly id: "viewer-curved";
    readonly outcome: "diagnostic";
    readonly code: "experimental_feature";
    readonly feature: "curved labels";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "plan-curved";
    readonly outcome: "diagnostic";
    readonly code: "experimental_feature";
    readonly feature: "advanced curved labels";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "viewer-terrain-line";
    readonly outcome: "diagnostic";
    readonly code: "experimental_feature";
    readonly feature: "terrain-elevated line labels";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "plan-complex-unshaped";
    readonly outcome: "diagnostic";
    readonly code: "experimental_feature";
    readonly feature: "complex-script shaping";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "plan-flat-unconfigured";
    readonly outcome: "diagnostic";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "plan-missing-terrain";
    readonly outcome: "diagnostic";
    readonly code: "placeholder_fallback";
    readonly feature: "terrain_sampler";
    readonly reason: "terrain_occluded";
}, {
    readonly id: "plan-hidden-terrain";
    readonly outcome: "diagnostic";
    readonly reason: "terrain_occluded";
}, {
    readonly id: "plan-repeat";
    readonly outcome: "render";
}, {
    readonly id: "viewer-repeat";
    readonly outcome: "render";
}, {
    readonly id: "plan-flat-preset";
    readonly outcome: "render";
}, {
    readonly id: "viewer-flat-line";
    readonly outcome: "render";
}, {
    readonly id: "plan-terrain-point";
    readonly outcome: "render";
}, {
    readonly id: "viewer-terrain-point";
    readonly outcome: "render";
}, {
    readonly id: "complex-shaped";
    readonly outcome: "render";
    readonly requires: "Prepared HarfBuzz FontAtlas with complete script coverage";
}, {
    readonly id: "point";
    readonly outcome: "render";
}, {
    readonly id: "polygon";
    readonly outcome: "render";
}, {
    readonly id: "callout";
    readonly outcome: "render";
}, {
    readonly id: "plan-terrain-line";
    readonly outcome: "diagnostic";
    readonly code: "experimental_feature";
    readonly feature: "terrain-elevated line labels";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "feature-line-unconfigured";
    readonly outcome: "diagnostic";
    readonly code: "experimental_feature";
    readonly feature: "line labels";
    readonly reason: "unsupported_geometry_type";
}, {
    readonly id: "feature-missing-terrain";
    readonly outcome: "diagnostic";
    readonly code: "unavailable_terrain_sampler";
    readonly reason: "terrain_occluded";
}];
export declare function labelCase(id: string): {
    id: string;
    outcome: string;
    code?: string;
    feature?: string;
    reason?: LabelRejectionReason;
};
