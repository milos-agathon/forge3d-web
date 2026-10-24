// #if terrain_vt
// #if terrain_material
fn terrain_vt_page_dims(mip_level: u32) -> vec2<u32> {
    let base_dims = vec2<u32>(
        max(terrain_vt_uniforms.config1.z, 1u),
        max(terrain_vt_uniforms.config1.w, 1u),
    );
    let divisor = 1u << mip_level;
    let bias = divisor - 1u;
    return max(
        (base_dims + vec2<u32>(bias, bias)) / vec2<u32>(divisor, divisor),
        vec2<u32>(1u, 1u),
    );
}

fn terrain_vt_page_table_layer(material_index: u32, mip_level: u32) -> i32 {
    let max_mip_levels = max(terrain_vt_uniforms.config2.x, 1u);
    return i32(material_index * max_mip_levels + mip_level);
}

fn terrain_vt_feedback_index(material_index: u32, mip_level: u32, tile_x: u32, tile_y: u32) -> u32 {
    let base_pages_x = max(terrain_vt_uniforms.config1.z, 1u);
    let base_pages_y = max(terrain_vt_uniforms.config1.w, 1u);
    return (((material_index * max(terrain_vt_uniforms.config2.x, 1u)) + mip_level) * base_pages_y + tile_y) * base_pages_x + tile_x;
}

// #endif

// #endif
