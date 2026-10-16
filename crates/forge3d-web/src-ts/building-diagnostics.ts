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
  code:
    | "missing_texture_path"
    | "missing_uvs"
    | "unsupported_texture_format"
    | "placeholder_fallback"
    | "unsupported_feature"
    | "pro_gated_path";
  objectId: string | null;
  severity: "error";
  details: Record<string, unknown>;
}
export interface BuildingTextureReport {
  status: "ok" | "error";
  supportLevel:
    | "supported"
    | "unsupported"
    | "placeholder/fallback"
    | "Pro-gated";
  texturedMaterialStatus: "none" | "unsupported" | "placeholder/fallback";
  diagnostics: BuildingDiagnostic[];
  unsupportedFeatures: Record<string, string>;
  texturedMaterials: BuildingTextureRequest[];
}
/** A material/UV/asset probe never advertises textured building rendering. */
export function diagnoseBuildingTextures(
  requests: readonly BuildingTextureRequest[],
  proGated = false,
): BuildingTextureReport {
  const diagnostics: BuildingDiagnostic[] = [],
    unsupportedFeatures: Record<string, string> = {},
    add = (
      code: BuildingDiagnostic["code"],
      objectId: string | null,
      details: Record<string, unknown>,
    ) => diagnostics.push({ code, objectId, severity: "error", details });
  let fallback = false;
  if (proGated) {
    add("pro_gated_path", null, { feature: "building import" });
    unsupportedFeatures["buildings.pro_gated_path"] = "Pro-gated";
  }
  for (const r of requests) {
    const detail = { material_id: r.materialId };
    if (!r.albedoTexture || r.assetAvailable !== true)
      add("missing_texture_path", r.objectId, {
        ...detail,
        path: r.albedoTexture ?? null,
      });
    if (!r.uvAvailable) add("missing_uvs", r.objectId, detail);
    const format = (
      r.textureFormat ??
      r.albedoTexture?.split(".").at(-1) ??
      ""
    ).toLowerCase();
    if (!["png", "jpg", "jpeg"].includes(format))
      add("unsupported_texture_format", r.objectId, { ...detail, format });
    if (r.scalarFallback) {
      fallback = true;
      add("placeholder_fallback", r.objectId, {
        ...detail,
        feature: "building textured material scalar fallback",
      });
    } else
      add("unsupported_feature", r.objectId, {
        ...detail,
        feature: "building textured PBR render path",
      });
  }
  if (requests.length)
    unsupportedFeatures["buildings.textured_pbr"] = "unsupported";
  const status = requests.length
    ? fallback
      ? "placeholder/fallback"
      : "unsupported"
    : "none";
  return {
    status: diagnostics.length ? "error" : "ok",
    supportLevel: requests.length
      ? fallback
        ? "placeholder/fallback"
        : "unsupported"
      : proGated
        ? "Pro-gated"
        : "supported",
    texturedMaterialStatus: status,
    diagnostics,
    unsupportedFeatures,
    texturedMaterials: structuredClone([...requests]),
  };
}
