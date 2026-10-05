export type LabelPoint = [number, number, number];
export type LabelRect = [number, number, number, number];
export type LabelWorldBounds = [number, number, number, number, number, number];
export type LabelRejectionReason = "collision" | "outside_view" | "missing_glyph" | "priority_lost" | "keepout_region" | "terrain_occluded" | "invalid_geometry" | "unsupported_geometry_type" | "empty_text";
export interface LabelDiagnostic {
    code: string;
    severity: "warning" | "error";
    message: string;
    remediation: string;
    support_level: string;
    layer_id: string | null;
    object_id: string | null;
    details: Record<string, unknown>;
}
export interface LabelGeometry {
    type: string;
    coordinates: unknown;
}
export interface LabelRecord {
    id?: string | number;
    source_id?: string;
    text: string;
    geometry?: LabelGeometry;
    position?: number[];
    world_pos?: number[];
    geometry_type?: string;
    priority?: number;
    priority_class?: string;
    repeat_distance?: number;
    placement_preset?: string;
    curved_text?: boolean;
    requires_terrain?: boolean;
    terrain_mode?: string;
    terrain_sample?: Record<string, unknown>;
    terrain?: Record<string, unknown>;
    candidate_policy?: {
        offset_px?: number;
        radial_count?: number;
        radial_radius_px?: number;
        radial_jitter_deg?: number;
    };
    leader_line?: boolean;
    typography?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface LabelCandidate {
    candidate_id: string;
    candidate_type: string;
    anchor: LabelPoint;
    score: number;
    bounds: LabelRect;
    terrain_sample: Record<string, unknown>;
    details: Record<string, unknown>;
    ordering_key: string;
}
export interface AcceptedLabel {
    label_id: string;
    source_id: string;
    text: string;
    geometry_type: string;
    candidate: LabelCandidate;
    candidates: LabelCandidate[];
    priority_class: string;
    screen_bounds: LabelRect;
    world_bounds: LabelWorldBounds;
    typography: Record<string, unknown>;
    glyphs: string[];
    ordering_key: string;
}
export interface RejectedLabel {
    label_id: string;
    source_id: string;
    reason: LabelRejectionReason;
    candidate_id: string | null;
    diagnostic_refs: string[];
    ordering_key: string;
    details: Record<string, unknown>;
}
export interface KeepoutRegionInput {
    region_id: string;
    kind: string;
    bounds: LabelRect;
    priority?: number;
}
export interface PriorityClassInput {
    name: string;
    rank: number;
    tie_break_policy?: string;
}
export interface LabelPlanData {
    payload_version: number;
    seed: number;
    accepted: AcceptedLabel[];
    rejected: RejectedLabel[];
    diagnostics: LabelDiagnostic[];
    bounds: {
        screen: LabelRect | null;
        world: LabelWorldBounds | null;
        keepouts?: KeepoutRegionInput[];
        priority_rules?: PriorityClassInput[];
    };
}
export interface LabelTerrainSampler {
    sample(x: number, y: number, z: number): Record<string, unknown> | number | null | undefined;
}
export interface LabelPlanOptions {
    labels: readonly LabelRecord[] | Record<string, LabelRecord>;
    camera?: unknown;
    viewport: [number, number] | {
        width: number;
        height: number;
    };
    terrain?: LabelTerrainSampler | Record<string, unknown> | null;
    keepouts?: readonly KeepoutRegionInput[];
    priority_rules?: readonly PriorityClassInput[] | "cartographic";
    typography?: Record<string, unknown>;
    glyph_atlas?: {
        glyphs: readonly string[];
    } | readonly string[];
    seed?: number;
    /** A prepared font atlas promotes shaping only when every run has real glyphs. */
    fontAtlas?: {
        covers(text: string): boolean;
        validateText(text: string): LabelDiagnostic[];
    };
}
export interface TypographyInput {
    fontSize?: number;
    tracking?: number;
    kerning?: boolean;
    lineHeight?: number;
    wordSpacing?: number;
    baselineShift?: number;
    multiline?: boolean;
    callout?: boolean;
    calloutOffset?: [number, number];
    direction?: "ltr" | "rtl" | undefined;
    language?: string | undefined;
}
export interface ShapedGlyph {
    glyphId: number;
    cluster: number;
    fontId: string;
    x: number;
    y: number;
    xAdvance: number;
    yAdvance: number;
    path: {
        type: string;
        values: number[];
    }[];
}
export interface ShapedText {
    glyphs: ShapedGlyph[];
    width: number;
    height: number;
    lineCount: number;
    lineHeight: number;
    diagnostics: LabelDiagnostic[];
    kerningApplied: boolean;
    tracking: number;
}
export interface LabelOperationResult {
    ok: boolean;
    id: number | null;
    diagnostics: LabelDiagnostic[];
}
export interface LabelLayerSnapshot {
    version: 1;
    enabled: boolean;
    nextId: number;
    typography?: TypographyInput;
    declutter?: {
        algorithm: "greedy" | "annealing";
        seed: number;
        maxIterations: number;
    };
    labels: {
        id: number;
        text: string;
        position: LabelPoint;
        path?: LabelPoint[];
        style: LabelStyleInput;
        callout?: boolean;
    }[];
}
export interface LabelStyleInput {
    fontSize?: number;
    minDepth?: number;
    maxDepth?: number;
    depthFade?: number;
    horizonFadeAngle?: number;
    color?: [number, number, number, number];
    haloColor?: [number, number, number, number];
    haloWidth?: number;
    priority?: number;
    offset?: [number, number];
    minZoom?: number;
    maxZoom?: number;
    depthTest?: boolean;
    horizonCull?: boolean;
    underline?: boolean;
    smallCaps?: boolean;
    leader?: boolean;
    rotation?: number;
    repeatDistance?: number;
    placement?: "center" | "along";
}
