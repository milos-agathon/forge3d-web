use super::{
    materials_and_textures_from_json, texture_layout_entries, texture_memory_keys, FALLBACK_BYTES,
};

fn route_json(
    requested: &str,
    model: &str,
    effective: &str,
    implementation: &str,
) -> serde_json::Value {
    serde_json::json!({
        "requested": requested,
        "model": model,
        "effectiveModel": effective,
        "implementation": implementation,
    })
}

fn material_json(textures: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": "mat",
        "route": route_json("lambert", "lambert", "lambert", "exact"),
        "brdf": "lambert",
        "baseColor": [1.0, 1.0, 1.0, 1.0],
        "metallic": 0.0,
        "roughness": 0.5,
        "sheen": 0.0,
        "clearcoat": 0.0,
        "subsurface": 0.0,
        "anisotropy": 0.0,
        "textures": textures,
    })
}

fn snapshot_json(textures: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "revision": 1,
        "maxMaterials": 16,
        "materials": [
            {
                "slot": "default",
                "index": 0,
                "material": material_json(textures),
            }
        ],
    })
}

fn rgba_image(color_space: &str, format: &str) -> serde_json::Value {
    serde_json::json!({
        "width": 2,
        "height": 2,
        "format": format,
        "colorSpace": color_space,
        "levels": [
            {
                "width": 2,
                "height": 2,
                "data": [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255],
            },
            { "width": 1, "height": 1, "data": [10, 20, 30, 255] },
        ],
        "compressed": false,
        "sourceFormat": "raw",
        "effectiveQuality": "native",
    })
}

fn sampler_json() -> serde_json::Value {
    serde_json::json!({
        "wrapU": "repeat",
        "wrapV": "clamp-to-edge",
        "magFilter": "linear",
        "minFilter": "linear",
        "mipmapFilter": "linear",
        "maxAnisotropy": 4,
    })
}

#[test]
fn textures_parse_valid_set_and_flags() {
    let textures = serde_json::json!({
        "baseColor": rgba_image("srgb", "rgba8unorm-srgb"),
        "normal": rgba_image("linear", "rgba8unorm"),
        "sampler": sampler_json(),
    });
    let parsed = materials_and_textures_from_json(&snapshot_json(textures))
        .expect("valid texture set parses");
    let set = parsed.texture_sets.get(&0).expect("texture set for slot 0");
    assert_eq!(set.flag_bits(), 1 | 2);
    assert_eq!(parsed.state.slots[0].material.flags, 1 | 2);
    assert_eq!(set.payload_bytes(), 40);
    assert_eq!(set.sampler.address_mode_v, wgpu::AddressMode::ClampToEdge);
    assert_eq!(set.sampler.mipmap_filter, wgpu::MipmapFilterMode::Linear);
    assert_eq!(set.sampler.max_anisotropy, 4);
}

#[test]
fn textures_reject_anisotropy_without_linear_filters() {
    for filter in ["magFilter", "minFilter", "mipmapFilter"] {
        let mut sampler = sampler_json();
        sampler[filter] = serde_json::json!("nearest");
        let textures = serde_json::json!({
            "baseColor": rgba_image("srgb", "rgba8unorm-srgb"),
            "sampler": sampler,
        });
        assert!(
            materials_and_textures_from_json(&snapshot_json(textures)).is_err(),
            "{filter} nearest with anisotropy must reject"
        );
    }
    let nearest = serde_json::json!({
        "wrapU": "repeat",
        "wrapV": "repeat",
        "magFilter": "nearest",
        "minFilter": "nearest",
        "mipmapFilter": "nearest",
        "maxAnisotropy": 1,
    });
    let textures = serde_json::json!({
        "baseColor": rgba_image("srgb", "rgba8unorm-srgb"),
        "sampler": nearest,
    });
    let parsed = materials_and_textures_from_json(&snapshot_json(textures))
        .expect("nearest sampler with anisotropy 1 parses");
    let set = parsed.texture_sets.get(&0).expect("texture set for slot 0");
    assert_eq!(set.sampler.mag_filter, wgpu::FilterMode::Nearest);
    assert_eq!(set.sampler.max_anisotropy, 1);
}

#[test]
fn textures_missing_set_yields_empty_flags() {
    let parsed = materials_and_textures_from_json(&snapshot_json(serde_json::Value::Null))
        .expect("null textures allowed");
    assert_eq!(parsed.state.slots[0].material.flags, 0);
    let set = parsed.texture_sets.get(&0).expect("default texture set");
    assert_eq!(set.payload_bytes(), 0);
}

#[test]
fn textures_reject_wrong_level_byte_size() {
    let mut image = rgba_image("srgb", "rgba8unorm-srgb");
    image["levels"][0]["data"] = serde_json::json!([1, 2, 3]);
    let textures = serde_json::json!({ "baseColor": image });
    assert!(materials_and_textures_from_json(&snapshot_json(textures)).is_err());
}

#[test]
fn textures_reject_srgb_normal_map() {
    let textures = serde_json::json!({
        "normal": rgba_image("srgb", "rgba8unorm-srgb"),
    });
    assert!(materials_and_textures_from_json(&snapshot_json(textures)).is_err());
}

#[test]
fn textures_reject_mismatched_mip_chain() {
    let mut image = rgba_image("linear", "rgba8unorm");
    image["levels"][1] = serde_json::json!({
        "width": 2,
        "height": 1,
        "data": [0, 0, 0, 0, 0, 0, 0, 0],
    });
    let textures = serde_json::json!({ "metallicRoughness": image });
    assert!(materials_and_textures_from_json(&snapshot_json(textures)).is_err());
}

#[test]
fn textures_reject_unknown_format_and_bad_sampler() {
    let textures = serde_json::json!({
        "baseColor": rgba_image("srgb", "rgba16float"),
    });
    assert!(materials_and_textures_from_json(&snapshot_json(textures)).is_err());

    let mut sampler = sampler_json();
    sampler["maxAnisotropy"] = serde_json::json!(3);
    let textures = serde_json::json!({
        "baseColor": rgba_image("srgb", "rgba8unorm-srgb"),
        "sampler": sampler,
    });
    assert!(materials_and_textures_from_json(&snapshot_json(textures)).is_err());
}

#[test]
fn textures_layout_has_six_entries_and_two_ledger_keys() {
    let entries = texture_layout_entries();
    assert_eq!(entries.len(), 6);
    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(entry.binding, index as u32);
    }
    assert_eq!(texture_memory_keys().len(), 2);
    assert_eq!(FALLBACK_BYTES, 20);
}
