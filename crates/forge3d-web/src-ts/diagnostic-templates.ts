// Generated from the hash-pinned final native diagnostics by generate-w18-native.py.
export const diagnosticTemplates = {
  "crs_mismatch": {
    "code": "crs_mismatch",
    "severity": "error",
    "message": "Layer CRS differs from the scene or terrain CRS and no transform was provided.",
    "remediation": "Use matching CRS metadata or provide an explicit transform before rendering.",
    "support_level": "unsupported"
  },
  "missing_glyphs": {
    "code": "missing_glyphs",
    "severity": "warning",
    "message": "2 glyphs are missing from the active atlas.",
    "remediation": "Load an atlas with the missing glyphs or change label text before rendering.",
    "support_level": "underdeveloped"
  },
  "unsupported_style_field": {
    "code": "unsupported_style_field",
    "severity": "warning",
    "message": "Style layer uses paint or layout fields that forge3d does not support.",
    "remediation": "Remove unsupported fields or use the documented local feature styling subset.",
    "support_level": "unsupported"
  },
  "unsupported_style_layer_type": {
    "code": "unsupported_style_layer_type",
    "severity": "error",
    "message": "Style layer type is not supported by forge3d offline feature styling.",
    "remediation": "Use a supported local feature layer type such as fill, line, or circle.",
    "support_level": "unsupported"
  },
  "pro_gated_path": {
    "code": "pro_gated_path",
    "severity": "error",
    "message": "Requested workflow requires a Pro-gated native path.",
    "remediation": "Enable the required Pro/native capability or choose a supported public path.",
    "support_level": "Pro-gated"
  },
  "placeholder_fallback": {
    "code": "placeholder_fallback",
    "severity": "error",
    "message": "Requested workflow would use placeholder or non-renderable fallback output.",
    "remediation": "Use a renderable supported path or keep the workflow blocked before render.",
    "support_level": "placeholder/fallback"
  },
  "experimental_feature": {
    "code": "experimental_feature",
    "severity": "warning",
    "message": "Requested workflow uses a feature that is not production-stable.",
    "remediation": "Treat this path as experimental or use a documented supported alternative.",
    "support_level": "experimental"
  },
  "vt_unsupported_family": {
    "code": "vt_unsupported_family",
    "severity": "error",
    "message": "Requested terrain virtual-texturing family is not paged by the native runtime.",
    "remediation": "Use the albedo VT family or wait for native normal/mask runtime support.",
    "support_level": "unsupported"
  },
  "python_public_3dtiles_incomplete": {
    "code": "python_public_3dtiles_incomplete",
    "severity": "error",
    "message": "Public Python 3D Tiles workflow cannot complete the requested render path.",
    "remediation": "Use supported local fixtures only for validation, or wait for public MapScene integration.",
    "support_level": "underdeveloped"
  },
  "estimated_gpu_memory": {
    "code": "estimated_gpu_memory",
    "severity": "warning",
    "message": "Estimated GPU memory use exceeds the configured budget.",
    "remediation": "Reduce layer resolution, simplify inputs, or increase the configured GPU memory budget.",
    "support_level": "supported"
  },
  "label_rejection_summary": {
    "code": "label_rejection_summary",
    "severity": "warning",
    "message": "3 label candidates were rejected during placement.",
    "remediation": "Inspect rejection reasons and adjust priorities, keepouts, glyph coverage, or geometry.",
    "support_level": "underdeveloped"
  },
  "missing_label_field": {
    "code": "missing_label_field",
    "severity": "error",
    "message": "Label text expression references a missing feature field.",
    "remediation": "Provide the referenced property or change the label text expression.",
    "support_level": "unsupported"
  },
  "unicode_coverage_gap": {
    "code": "unicode_coverage_gap",
    "severity": "warning",
    "message": "Label text contains Unicode code points outside configured atlas coverage.",
    "remediation": "Load an atlas or fallback range covering the missing code points before rendering.",
    "support_level": "underdeveloped"
  },
  "unsupported_tile_format": {
    "code": "unsupported_tile_format",
    "severity": "error",
    "message": "3D Tiles source uses a format that is not supported by the public MapScene workflow.",
    "remediation": "Use a supported local tileset JSON or B3DM fixture, or keep the layer diagnostic-only.",
    "support_level": "unsupported"
  },
  "unsupported_tile_feature": {
    "code": "unsupported_tile_feature",
    "severity": "error",
    "message": "3D Tiles content requires a feature not supported by the public MapScene workflow.",
    "remediation": "Remove the unsupported tile feature or use a documented supported local fixture.",
    "support_level": "unsupported"
  },
  "missing_external_asset": {
    "code": "missing_external_asset",
    "severity": "error",
    "message": "Scene or bundle references an external asset that cannot be found.",
    "remediation": "Provide the referenced asset or update the scene/bundle to point at an available file.",
    "support_level": "unsupported"
  },
  "missing_texture_path": {
    "code": "missing_texture_path",
    "severity": "error",
    "message": "Building material references a texture path that is missing or unreadable.",
    "remediation": "Provide the referenced texture asset or remove the textured-material intent before rendering.",
    "support_level": "unsupported"
  },
  "missing_uvs": {
    "code": "missing_uvs",
    "severity": "error",
    "message": "Building material requests a texture but the affected geometry has no usable UVs.",
    "remediation": "Provide UV coordinates for the textured geometry or use an explicit scalar-material fallback.",
    "support_level": "unsupported"
  },
  "unsupported_texture_format": {
    "code": "unsupported_texture_format",
    "severity": "error",
    "message": "Building material texture uses a format that is not supported by the current MapScene workflow.",
    "remediation": "Use a documented supported texture format or keep the textured material diagnostic-only.",
    "support_level": "unsupported"
  },
  "unavailable_cache_lod_stats": {
    "code": "unavailable_cache_lod_stats",
    "severity": "warning",
    "message": "Requested cache or LOD statistics are not available for this layer.",
    "remediation": "Use available layer metadata only, or add a renderer/stat source before relying on these stats.",
    "support_level": "underdeveloped"
  },
  "unsupported_instancing_path": {
    "code": "unsupported_instancing_path",
    "severity": "error",
    "message": "Requested MapScene instancing workflow is not supported in this configuration.",
    "remediation": "Use a supported non-instanced workflow or enable a documented instancing path with tests.",
    "support_level": "unsupported"
  },
  "unavailable_terrain_sampler": {
    "code": "unavailable_terrain_sampler",
    "severity": "warning",
    "message": "Terrain-height sampling was requested but no terrain sampler is available.",
    "remediation": "Provide a terrain sampler or choose a label terrain policy that does not require sampling.",
    "support_level": "underdeveloped"
  }
} as const;
