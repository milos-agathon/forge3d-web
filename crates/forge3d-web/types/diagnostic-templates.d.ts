export declare const diagnosticTemplates: {
    readonly crs_mismatch: {
        readonly code: "crs_mismatch";
        readonly severity: "error";
        readonly message: "Layer CRS differs from the scene or terrain CRS and no transform was provided.";
        readonly remediation: "Use matching CRS metadata or provide an explicit transform before rendering.";
        readonly support_level: "unsupported";
    };
    readonly missing_glyphs: {
        readonly code: "missing_glyphs";
        readonly severity: "warning";
        readonly message: "2 glyphs are missing from the active atlas.";
        readonly remediation: "Load an atlas with the missing glyphs or change label text before rendering.";
        readonly support_level: "underdeveloped";
    };
    readonly unsupported_style_field: {
        readonly code: "unsupported_style_field";
        readonly severity: "warning";
        readonly message: "Style layer uses paint or layout fields that forge3d does not support.";
        readonly remediation: "Remove unsupported fields or use the documented local feature styling subset.";
        readonly support_level: "unsupported";
    };
    readonly unsupported_style_layer_type: {
        readonly code: "unsupported_style_layer_type";
        readonly severity: "error";
        readonly message: "Style layer type is not supported by forge3d offline feature styling.";
        readonly remediation: "Use a supported local feature layer type such as fill, line, or circle.";
        readonly support_level: "unsupported";
    };
    readonly pro_gated_path: {
        readonly code: "pro_gated_path";
        readonly severity: "error";
        readonly message: "Requested workflow requires a Pro-gated native path.";
        readonly remediation: "Enable the required Pro/native capability or choose a supported public path.";
        readonly support_level: "Pro-gated";
    };
    readonly placeholder_fallback: {
        readonly code: "placeholder_fallback";
        readonly severity: "error";
        readonly message: "Requested workflow would use placeholder or non-renderable fallback output.";
        readonly remediation: "Use a renderable supported path or keep the workflow blocked before render.";
        readonly support_level: "placeholder/fallback";
    };
    readonly experimental_feature: {
        readonly code: "experimental_feature";
        readonly severity: "warning";
        readonly message: "Requested workflow uses a feature that is not production-stable.";
        readonly remediation: "Treat this path as experimental or use a documented supported alternative.";
        readonly support_level: "experimental";
    };
    readonly vt_unsupported_family: {
        readonly code: "vt_unsupported_family";
        readonly severity: "error";
        readonly message: "Requested terrain virtual-texturing family is not paged by the native runtime.";
        readonly remediation: "Use the albedo VT family or wait for native normal/mask runtime support.";
        readonly support_level: "unsupported";
    };
    readonly python_public_3dtiles_incomplete: {
        readonly code: "python_public_3dtiles_incomplete";
        readonly severity: "error";
        readonly message: "Public Python 3D Tiles workflow cannot complete the requested render path.";
        readonly remediation: "Use supported local fixtures only for validation, or wait for public MapScene integration.";
        readonly support_level: "underdeveloped";
    };
    readonly estimated_gpu_memory: {
        readonly code: "estimated_gpu_memory";
        readonly severity: "warning";
        readonly message: "Estimated GPU memory use exceeds the configured budget.";
        readonly remediation: "Reduce layer resolution, simplify inputs, or increase the configured GPU memory budget.";
        readonly support_level: "supported";
    };
    readonly label_rejection_summary: {
        readonly code: "label_rejection_summary";
        readonly severity: "warning";
        readonly message: "3 label candidates were rejected during placement.";
        readonly remediation: "Inspect rejection reasons and adjust priorities, keepouts, glyph coverage, or geometry.";
        readonly support_level: "underdeveloped";
    };
    readonly missing_label_field: {
        readonly code: "missing_label_field";
        readonly severity: "error";
        readonly message: "Label text expression references a missing feature field.";
        readonly remediation: "Provide the referenced property or change the label text expression.";
        readonly support_level: "unsupported";
    };
    readonly unicode_coverage_gap: {
        readonly code: "unicode_coverage_gap";
        readonly severity: "warning";
        readonly message: "Label text contains Unicode code points outside configured atlas coverage.";
        readonly remediation: "Load an atlas or fallback range covering the missing code points before rendering.";
        readonly support_level: "underdeveloped";
    };
    readonly unsupported_tile_format: {
        readonly code: "unsupported_tile_format";
        readonly severity: "error";
        readonly message: "3D Tiles source uses a format that is not supported by the public MapScene workflow.";
        readonly remediation: "Use a supported local tileset JSON or B3DM fixture, or keep the layer diagnostic-only.";
        readonly support_level: "unsupported";
    };
    readonly unsupported_tile_feature: {
        readonly code: "unsupported_tile_feature";
        readonly severity: "error";
        readonly message: "3D Tiles content requires a feature not supported by the public MapScene workflow.";
        readonly remediation: "Remove the unsupported tile feature or use a documented supported local fixture.";
        readonly support_level: "unsupported";
    };
    readonly missing_external_asset: {
        readonly code: "missing_external_asset";
        readonly severity: "error";
        readonly message: "Scene or bundle references an external asset that cannot be found.";
        readonly remediation: "Provide the referenced asset or update the scene/bundle to point at an available file.";
        readonly support_level: "unsupported";
    };
    readonly missing_texture_path: {
        readonly code: "missing_texture_path";
        readonly severity: "error";
        readonly message: "Building material references a texture path that is missing or unreadable.";
        readonly remediation: "Provide the referenced texture asset or remove the textured-material intent before rendering.";
        readonly support_level: "unsupported";
    };
    readonly missing_uvs: {
        readonly code: "missing_uvs";
        readonly severity: "error";
        readonly message: "Building material requests a texture but the affected geometry has no usable UVs.";
        readonly remediation: "Provide UV coordinates for the textured geometry or use an explicit scalar-material fallback.";
        readonly support_level: "unsupported";
    };
    readonly unsupported_texture_format: {
        readonly code: "unsupported_texture_format";
        readonly severity: "error";
        readonly message: "Building material texture uses a format that is not supported by the current MapScene workflow.";
        readonly remediation: "Use a documented supported texture format or keep the textured material diagnostic-only.";
        readonly support_level: "unsupported";
    };
    readonly unavailable_cache_lod_stats: {
        readonly code: "unavailable_cache_lod_stats";
        readonly severity: "warning";
        readonly message: "Requested cache or LOD statistics are not available for this layer.";
        readonly remediation: "Use available layer metadata only, or add a renderer/stat source before relying on these stats.";
        readonly support_level: "underdeveloped";
    };
    readonly unsupported_instancing_path: {
        readonly code: "unsupported_instancing_path";
        readonly severity: "error";
        readonly message: "Requested MapScene instancing workflow is not supported in this configuration.";
        readonly remediation: "Use a supported non-instanced workflow or enable a documented instancing path with tests.";
        readonly support_level: "unsupported";
    };
    readonly unavailable_terrain_sampler: {
        readonly code: "unavailable_terrain_sampler";
        readonly severity: "warning";
        readonly message: "Terrain-height sampling was requested but no terrain sampler is available.";
        readonly remediation: "Provide a terrain sampler or choose a label terrain policy that does not require sampling.";
        readonly support_level: "underdeveloped";
    };
};
