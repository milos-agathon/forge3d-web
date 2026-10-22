export declare const MAP_SCENE_LAYER_KINDS: readonly ["raster", "vector", "labels", "buildings", "mesh", "point-cloud", "tiles3d", "nodes", "scatter", "trace", "diagnostic"];
export declare function mapKindPolicy(kind: string): {
    known: boolean;
    eligible: boolean;
    level: "placeholder/fallback" | "underdeveloped" | "supported";
    scope: string;
    limitations: string[];
    formats: readonly string[] | undefined;
    fields: string[];
    diagnosticCodes: string[];
};
export declare function mapIntegrationDiagnostic(kind: string, layerId: string): import("./diagnostics.js").Diagnostic | undefined;
export declare const mapSupportKinds: string[];
