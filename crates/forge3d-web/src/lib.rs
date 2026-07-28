pub mod error;
pub mod inputs;
pub mod io;
pub mod runtime;

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

#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn install_panic_hook() {
    console_error_panic_hook::set_once();
}
