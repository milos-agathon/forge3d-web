fn main() {
    let flat = [0.; 64];
    let raised = [1.25; 64];
    for preset in ["valley_fog", "plume", "localized_haze"] {
        for height in [0, 1] {
            let cfg = DensityVolumeConfig {
                preset: preset.into(),
                center: [4., 2., 4.],
                size: [6., 4., 6.],
                resolution: [8, 6, 8],
                density_scale: 1.,
                edge_softness: 0.25,
                noise_strength: 0.3,
                floor_offset: 0.,
                ceiling: 0.4,
                plume_spread: 0.35,
                wind: [0.2, 1., 0.1],
                seed: 13,
            };
            let ctx = TerrainVolumeContext {
                heightmap: if height == 0 { &flat } else { &raised },
                height_dims: (8, 8),
                terrain_width: 8.,
                domain: (0., 1.),
                z_scale: 1.,
            };
            println!(
                "{{\"preset\":\"{}\",\"terrainHeight\":{},\"data\":{:?}}}",
                preset,
                if height == 0 { 0. } else { 1.25 },
                generate_density_volume(ctx, &cfg)
            );
        }
    }
}
