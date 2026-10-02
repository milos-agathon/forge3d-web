struct DensityVolumeConfig {
    preset: String,
    center: [f32; 3],
    size: [f32; 3],
    resolution: [u32; 3],
    density_scale: f32,
    edge_softness: f32,
    noise_strength: f32,
    floor_offset: f32,
    ceiling: f32,
    plume_spread: f32,
    wind: [f32; 3],
    seed: u32,
}
#[derive(Clone, Copy)]
struct TerrainVolumeContext<'a> {
    heightmap: &'a [f32],
    height_dims: (u32, u32),
    terrain_width: f32,
    domain: (f32, f32),
    z_scale: f32,
}
