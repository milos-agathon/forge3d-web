pub mod error;
pub mod inputs;
pub mod io;
pub mod offline_api;
pub mod runtime;
pub mod terrain_material_input;

pub use crate::error::Forge3DError;
pub use crate::runtime::Forge3DRuntime;

#[wasm_bindgen::prelude::wasm_bindgen(js_name = loadTerrainHeightmapSource)]
pub async fn load_terrain_heightmap_source_for_js(
    input: wasm_bindgen::JsValue,
    max_texture_dimension_2d: u32,
    max_buffer_size: f64,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    if !max_buffer_size.is_finite() || max_buffer_size <= 0.0 {
        return Err(crate::error::to_js_error(crate::error::WebError::new(
            crate::error::Forge3DErrorCode::InvalidInput,
            "maxBufferSize must be finite and positive",
        )));
    }
    let limits = crate::inputs::TerrainPhysicalLimits {
        max_texture_dimension_2d,
        max_buffer_size: max_buffer_size as u64,
    };
    let terrain = crate::io::load_terrain_heightmap_source(input, limits)
        .await
        .map_err(crate::error::to_js_error)?;
    terrain_options_to_js(terrain).map_err(crate::error::to_js_error)
}

fn terrain_options_to_js(
    terrain: crate::inputs::TerrainHeightmapOptions,
) -> Result<wasm_bindgen::JsValue, crate::error::WebError> {
    use wasm_bindgen::JsValue;

    let result = js_sys::Object::new();
    set_js_value(&result, "width", &JsValue::from_f64(terrain.width as f64))?;
    set_js_value(&result, "height", &JsValue::from_f64(terrain.height as f64))?;
    let heights = js_sys::Float32Array::from(terrain.heights.as_slice());
    set_js_value(&result, "heights", heights.as_ref())?;

    let ramp = js_sys::Object::new();
    let stops = js_sys::Array::new();
    for stop in terrain.color_ramp.stops {
        let output = js_sys::Object::new();
        set_js_value(
            &output,
            "position",
            &JsValue::from_f64(stop.position as f64),
        )?;
        let color = js_sys::Array::new();
        for channel in stop.color {
            color.push(&JsValue::from_f64(channel as f64));
        }
        set_js_value(&output, "color", color.as_ref())?;
        stops.push(output.as_ref());
    }
    set_js_value(&ramp, "stops", stops.as_ref())?;
    set_js_value(&result, "colorRamp", ramp.as_ref())?;

    if let Some(spacing) = terrain.spacing {
        let values = js_sys::Array::new();
        for value in spacing {
            values.push(&JsValue::from_f64(value as f64));
        }
        set_js_value(&result, "spacing", values.as_ref())?;
    }
    if let Some(exaggeration) = terrain.exaggeration {
        set_js_value(
            &result,
            "exaggeration",
            &JsValue::from_f64(exaggeration as f64),
        )?;
    }
    if let Some(domain) = terrain.domain {
        let values = js_sys::Array::new();
        for value in domain {
            values.push(&JsValue::from_f64(value as f64));
        }
        set_js_value(&result, "domain", values.as_ref())?;
    }
    if let Some(nodata) = terrain.nodata {
        set_js_value(&result, "nodata", &JsValue::from_f64(nodata as f64))?;
    }
    if let Some(crs) = terrain.crs {
        set_js_value(&result, "crs", &JsValue::from_str(&crs))?;
    }
    let height_ao = serde_wasm_bindgen::to_value(&terrain.height_ao).map_err(|error| {
        crate::error::WebError::with_details(
            crate::error::Forge3DErrorCode::InternalError,
            "Failed to serialize terrain heightAo options",
            JsValue::from_str(&error.to_string()),
        )
    })?;
    set_js_value(&result, "heightAo", &height_ao)?;
    let sun_visibility =
        serde_wasm_bindgen::to_value(&terrain.sun_visibility).map_err(|error| {
            crate::error::WebError::with_details(
                crate::error::Forge3DErrorCode::InternalError,
                "Failed to serialize terrain sunVisibility options",
                JsValue::from_str(&error.to_string()),
            )
        })?;
    set_js_value(&result, "sunVisibility", &sun_visibility)?;
    if let Some(debug_view) = terrain.debug_view {
        let value = serde_wasm_bindgen::to_value(&debug_view).map_err(|error| {
            crate::error::WebError::with_details(
                crate::error::Forge3DErrorCode::InternalError,
                "Failed to serialize terrain debugView",
                JsValue::from_str(&error.to_string()),
            )
        })?;
        set_js_value(&result, "debugView", &value)?;
    }
    Ok(result.into())
}

fn set_js_value(
    target: &js_sys::Object,
    name: &str,
    value: &wasm_bindgen::JsValue,
) -> Result<(), crate::error::WebError> {
    js_sys::Reflect::set(target, &wasm_bindgen::JsValue::from_str(name), value)
        .map(|_| ())
        .map_err(|details| {
            crate::error::WebError::with_details(
                crate::error::Forge3DErrorCode::InternalError,
                format!("Failed to create decoded terrain property {name}"),
                details,
            )
        })
}

// ---------------------------------------------------------------------------
// W08 (E7): pure-Rust clipmap / LOD-selection helpers exposed to the wasm
// bridge — same core APIs the runtime uses, so browser tests can compare
// GPU results against the CPU reference directly.
// ---------------------------------------------------------------------------

/// W08 (A4/E7): `generateClipmapMesh(config, center, terrainExtent)` — wraps
/// `terrain_clipmap::clipmap_generate`. `config` mirrors
/// `geometry.clipmap` (A1 defaults for absent fields); `center` is the
/// camera `[x, z]` and `terrainExtent` the square world extent that derives
/// `s0 = extent / (centerResolution * 8)`.
#[wasm_bindgen::prelude::wasm_bindgen(js_name = generateClipmapMesh)]
pub fn generate_clipmap_mesh_js(
    config: wasm_bindgen::JsValue,
    center: Vec<f32>,
    terrain_extent: f32,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    use wasm_bindgen::JsValue;

    let options: crate::inputs::TerrainClipmapJsOptions = serde_wasm_bindgen::from_value(config)
        .map_err(|error| {
            crate::error::to_js_error(crate::error::WebError::with_details(
                crate::error::Forge3DErrorCode::InvalidInput,
                "invalid clipmap config",
                JsValue::from_str(&error.to_string()),
            ))
        })?;
    if center.len() != 2 || !center.iter().all(|v| v.is_finite()) {
        return Err(crate::error::to_js_error(crate::error::WebError::new(
            crate::error::Forge3DErrorCode::InvalidInput,
            "clipmap center must be a finite [x, z] pair",
        )));
    }
    if !terrain_extent.is_finite() || terrain_extent <= 0.0 {
        return Err(crate::error::to_js_error(crate::error::WebError::new(
            crate::error::Forge3DErrorCode::InvalidInput,
            "terrainExtent must be finite and greater than zero",
        )));
    }
    let core = options.to_core();
    // A1 defaults, matching `TerrainClipmapGeometry::with_spacing` /
    // `resolve` (base_cell_size does not affect mesh generation).
    let config = forge3d_core::terrain_clipmap::ClipmapConfig::new(
        core.ring_count.unwrap_or(4),
        core.ring_resolution.unwrap_or(64),
        core.center_resolution.unwrap_or(64),
        core.skirt_depth.unwrap_or(10.0),
        core.morph_range.unwrap_or(0.3).clamp(0.0, 1.0),
    )
    .map_err(crate::error::map_core_error)
    .map_err(crate::error::to_js_error)?;
    let mesh = forge3d_core::terrain_clipmap::clipmap_generate(
        &config,
        [center[0], center[1]],
        terrain_extent,
    );
    let out = js_sys::Object::new();
    let flatten =
        |pairs: &[[f32; 2]]| -> Vec<f32> { pairs.iter().flat_map(|pair| *pair).collect() };
    set_js_value(
        &out,
        "positions",
        &js_sys::Float32Array::from(flatten(&mesh.positions).as_slice()),
    )
    .map_err(crate::error::to_js_error)?;
    set_js_value(
        &out,
        "uvs",
        &js_sys::Float32Array::from(flatten(&mesh.uvs).as_slice()),
    )
    .map_err(crate::error::to_js_error)?;
    set_js_value(
        &out,
        "morphData",
        &js_sys::Float32Array::from(flatten(&mesh.morph_data).as_slice()),
    )
    .map_err(crate::error::to_js_error)?;
    set_js_value(
        &out,
        "indices",
        &js_sys::Uint32Array::from(mesh.indices.as_slice()),
    )
    .map_err(crate::error::to_js_error)?;
    for (name, value) in [
        ("vertexCount", mesh.vertex_count as f64),
        ("indexCount", mesh.index_count as f64),
        ("triangleCount", mesh.triangle_count as f64),
        ("ringsCount", mesh.rings_count as f64),
        (
            "triangleReductionPercent",
            mesh.triangle_reduction_percent as f64,
        ),
    ] {
        set_js_value(&out, name, &JsValue::from_f64(value)).map_err(crate::error::to_js_error)?;
    }
    Ok(out.into())
}

/// W08 (A4/E7): `calculateTriangleReduction(full, clipmap)` — reduction
/// percent of a clipmap triangle count vs the full-resolution grid.
#[wasm_bindgen::prelude::wasm_bindgen(js_name = calculateTriangleReduction)]
pub fn calculate_triangle_reduction_js(full: f64, clipmap: f64) -> f64 {
    f64::from(forge3d_core::terrain_clipmap::calculate_triangle_reduction(
        full as u64,
        clipmap as u64,
    ))
}

/// `selectLodTilesReference` input tiles — `boundsMin`/`boundsMax` +
/// optional `[min,max]` heights and either packed `tileId` or `(lod,x,y)`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LodReferenceTile {
    #[serde(default)]
    tile_id: Option<u32>,
    #[serde(default)]
    lod: Option<u32>,
    #[serde(default)]
    x: Option<u32>,
    #[serde(default)]
    y: Option<u32>,
    bounds_min: [f32; 2],
    bounds_max: [f32; 2],
    #[serde(default)]
    height_min: f32,
    #[serde(default)]
    height_max: f32,
}

/// `selectLodTilesReference` input params + tile list.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LodSelectReferenceInput {
    /// Column-major 4x4 view-projection (16 floats, glam layout).
    view_proj: Vec<f32>,
    camera_pos: [f32; 3],
    viewport_height: f32,
    /// Vertical field of view in radians.
    fov_y: f32,
    max_lod: u32,
    #[serde(default)]
    pixel_error_budget: Option<f32>,
    tiles: Vec<LodReferenceTile>,
}

/// W08 (E4/E7): `selectLodTilesReference(input)` — CPU mirror of the GPU
/// LOD pass via `terrain_clipmap::select_tiles`; output
/// `{tiles: [{tileId, lod, x, y, distance, selectedLod, visible}],
///   visibleCount, totalTriangles}` with every input tile sorted by
/// `(distance, tileId)`.
#[wasm_bindgen::prelude::wasm_bindgen(js_name = selectLodTilesReference)]
pub fn select_lod_tiles_reference_js(
    input: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    use wasm_bindgen::JsValue;

    let input: LodSelectReferenceInput =
        serde_wasm_bindgen::from_value(input).map_err(|error| {
            crate::error::to_js_error(crate::error::WebError::with_details(
                crate::error::Forge3DErrorCode::InvalidInput,
                "invalid LOD selection input",
                JsValue::from_str(&error.to_string()),
            ))
        })?;
    if input.view_proj.len() != 16 {
        return Err(crate::error::to_js_error(crate::error::WebError::new(
            crate::error::Forge3DErrorCode::InvalidInput,
            "viewProj must contain 16 column-major floats",
        )));
    }
    let view_proj: [f32; 16] = input.view_proj.try_into().unwrap_or([0.0; 16]);
    let mut params = forge3d_core::terrain_clipmap::LodSelectParams::new(
        glam::Mat4::from_cols_array(&view_proj),
        input.camera_pos,
        input.viewport_height,
        input.fov_y,
        input.max_lod,
    );
    if let Some(budget) = input.pixel_error_budget {
        params.pixel_error_budget = budget;
    }
    let tiles: Vec<forge3d_core::terrain_clipmap::LodTile> = input
        .tiles
        .iter()
        .map(|tile| {
            let tile_id = tile.tile_id.unwrap_or_else(|| {
                forge3d_core::terrain_clipmap::pack_tile_id(
                    tile.lod.unwrap_or(0),
                    tile.x.unwrap_or(0),
                    tile.y.unwrap_or(0),
                )
            });
            forge3d_core::terrain_clipmap::LodTile {
                tile_id,
                bounds_min: tile.bounds_min,
                bounds_max: tile.bounds_max,
                height_min: tile.height_min,
                height_max: tile.height_max,
            }
        })
        .collect();
    let selection = forge3d_core::terrain_clipmap::select_tiles(&params, &tiles);
    let out = js_sys::Object::new();
    let tiles_js = js_sys::Array::new();
    for tile in &selection.tiles {
        let (lod, x, y) = forge3d_core::terrain_clipmap::unpack_tile_id(tile.tile_id);
        let entry = js_sys::Object::new();
        for (name, value) in [
            ("tileId", tile.tile_id as f64),
            ("lod", lod as f64),
            ("x", x as f64),
            ("y", y as f64),
            ("distance", tile.distance as f64),
            ("selectedLod", tile.selected_lod as f64),
        ] {
            set_js_value(&entry, name, &JsValue::from_f64(value))
                .map_err(crate::error::to_js_error)?;
        }
        set_js_value(&entry, "visible", &JsValue::from_bool(tile.visible))
            .map_err(crate::error::to_js_error)?;
        tiles_js.push(&entry);
    }
    set_js_value(&out, "tiles", &tiles_js).map_err(crate::error::to_js_error)?;
    set_js_value(
        &out,
        "visibleCount",
        &JsValue::from_f64(selection.visible_count as f64),
    )
    .map_err(crate::error::to_js_error)?;
    set_js_value(
        &out,
        "totalTriangles",
        &JsValue::from_f64(selection.total_triangles as f64),
    )
    .map_err(crate::error::to_js_error)?;
    Ok(out.into())
}

/// W08 (E6/E7): `validateTerrainVtSupport(settings)` — resolves a
/// `material.virtualTexture` settings object against the native defaults
/// and returns the core `VtSupportReport` (status, diagnostics sorted by
/// objectId, layer summaries, supported/unsupported feature maps).
#[wasm_bindgen::prelude::wasm_bindgen(js_name = validateTerrainVtSupport)]
pub fn validate_terrain_vt_support_js(
    settings: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    let parsed: crate::terrain_material_input::VtJs = serde_wasm_bindgen::from_value(settings)
        .map_err(|error| {
            crate::error::to_js_error(crate::error::WebError::new(
                crate::error::Forge3DErrorCode::InvalidInput,
                format!("invalid virtualTexture settings: {error}"),
            ))
        })?;
    let settings = parsed.to_settings().map_err(crate::error::to_js_error)?;
    let report = forge3d_core::terrain_vt::validate_terrain_vt_support(&settings, None);
    serde::Serialize::serialize(
        &crate::terrain_material_input::vt_support_report_json(&report),
        &serde_wasm_bindgen::Serializer::json_compatible(),
    )
    .map_err(|error| {
        crate::error::to_js_error(crate::error::WebError::with_details(
            crate::error::Forge3DErrorCode::InternalError,
            "Failed to serialize the VT support report",
            wasm_bindgen::JsValue::from_str(&error.to_string()),
        ))
    })
}

#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn install_panic_hook() {
    console_error_panic_hook::set_once();
}
