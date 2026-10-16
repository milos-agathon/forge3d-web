export interface BuildingTextureRequest {
    materialId: string;
    objectId: string;
    albedoTexture?: string;
    textureFormat?: string;
    uvAvailable: boolean;
    assetAvailable?: boolean;
    scalarFallback?: boolean;
}
export interface BuildingDiagnostic {
    code: "missing_texture_path" | "missing_uvs" | "unsupported_texture_format" | "placeholder_fallback" | "unsupported_feature" | "pro_gated_path";
    objectId: string | null;
    severity: "error";
    details: Record<string, unknown>;
}
export interface BuildingTextureReport {
    status: "ok" | "error";
    supportLevel: "supported" | "unsupported" | "placeholder/fallback" | "Pro-gated";
    texturedMaterialStatus: "none" | "unsupported" | "placeholder/fallback";
    diagnostics: BuildingDiagnostic[];
    unsupportedFeatures: Record<string, string>;
    texturedMaterials: BuildingTextureRequest[];
}
/** A material/UV/asset probe never advertises textured building rendering. */
export declare function diagnoseBuildingTextures(requests: readonly BuildingTextureRequest[], proGated?: boolean): BuildingTextureReport;
