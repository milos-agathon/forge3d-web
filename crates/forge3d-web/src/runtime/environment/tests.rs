#[test]
fn shaders_validate() {
    let source = concat!(include_str!("sky.wgsl"), include_str!("effects.wgsl"));
    let m = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&m)
    .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));
}
#[test]
fn uniform_layout() {
    assert_eq!(std::mem::size_of::<super::gpu::Uniform>(), 512);
    assert_eq!(std::mem::offset_of!(super::gpu::Uniform, bits), 496);
}

#[test]
fn sampled_texture_layouts_fit_default_webgpu_limits() {
    fn count(entries: impl IntoIterator<Item = wgpu::BindGroupLayoutEntry>) -> usize {
        entries
            .into_iter()
            .filter(|e| matches!(e.ty, wgpu::BindingType::Texture { .. }))
            .count()
    }
    let environment = count(super::gpu::bindings::layout_entries());
    let ibl = count(crate::runtime::ibl::ibl_layout_entries())
        + count(crate::runtime::shadows::shadow_layout_entries());
    let shadow = 1;
    assert_eq!(environment, 7);
    assert!(environment + ibl + shadow <= 16);
    assert_eq!(std::mem::offset_of!(super::gpu::Uniform, p), 192);
}
