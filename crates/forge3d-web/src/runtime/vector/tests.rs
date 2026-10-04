use super::*;
#[test]
fn shaders_validate_with_exact_storage_contracts() {
    for (name, source) in [
        ("project", include_str!("project.wgsl").to_string()),
        (
            "draw",
            format!(
                "diagnostic(off, derivative_uniformity);\n{}",
                include_str!("draw.wgsl")
            ),
        ),
        ("resolve", include_str!("resolve.wgsl").to_string()),
        (
            "highlight-bounds",
            include_str!("highlight-bounds.wgsl").to_string(),
        ),
    ] {
        let module = naga::front::wgsl::parse_str(&source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(&source)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("{name}: {e:?}"));
    }
    assert_eq!(std::mem::size_of::<Params>(), 128);
    assert_eq!(std::mem::offset_of!(Params, camera), 112);
    assert_eq!(std::mem::offset_of!(Params, projection_round_mask), 120);
    assert_eq!(std::mem::offset_of!(Params, padding), 124);
    assert_eq!(std::mem::size_of::<Highlight>(), 48);
}
#[test]
fn projection_and_draw_uniform_offsets_match_rust() {
    for source in [include_str!("project.wgsl"), include_str!("draw.wgsl")] {
        let module = naga::front::wgsl::parse_str(source).unwrap();
        let params = module
            .types
            .iter()
            .find(|(_, ty)| ty.name.as_deref() == Some("Params"))
            .unwrap()
            .1;
        let naga::TypeInner::Struct { members, span } = &params.inner else {
            panic!("Params must be a struct");
        };
        assert_eq!(*span, 128);
        for (name, offset) in [
            ("camera", 112),
            ("projection_round_mask", 120),
            ("padding", 124),
        ] {
            assert_eq!(
                members
                    .iter()
                    .find(|member| member.name.as_deref() == Some(name))
                    .unwrap()
                    .offset,
                offset
            );
        }
    }
}
#[test]
fn dual_source_selection_has_a_truthful_fallback() {
    assert_eq!(
        resolve_mode("dual-source", false),
        (
            "wboit".into(),
            Some("dual-source-blending-unavailable".into())
        )
    );
    assert_eq!(
        resolve_mode("dual-source", true),
        ("dual-source".into(), None)
    );
    assert_eq!(resolve_mode("standard", true), ("standard".into(), None));
}
#[test]
fn malformed_geometry_is_rejected_before_allocation() {
    let mut p = Packet {
        vertices: vec![],
        oit: "auto".into(),
        culling: "auto".into(),
        feature_count: 0,
        atlas: Atlas {
            width: 1,
            height: 1,
            rgba: vec![255; 4],
        },
        highlights: vec![],
    };
    assert!(validate(&p).is_ok());
    p.vertices = vec![vec![0.; 32]; 3];
    assert!(validate(&p).is_err());
    for v in &mut p.vertices {
        v[20] = u32::MAX as f64;
    }
    assert!(validate(&p).is_ok());
    p.vertices[0][0] = f64::NAN;
    assert!(validate(&p).is_err());
}
