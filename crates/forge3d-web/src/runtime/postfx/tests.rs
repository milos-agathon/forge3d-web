use super::*;
#[test]
fn postfx_shaders_validate_with_baseline_capabilities() {
    for (label, source) in [
        ("postfx", SHADER),
        ("hzb", HZB_SHADER),
        ("output", OUTPUT_SHADER),
    ] {
        let module = naga::front::wgsl::parse_str(source)
            .unwrap_or_else(|e| panic!("{label}: {}", e.emit_to_string(source)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("{label}: {}", e.emit_to_string(source)));
    }
}
#[test]
fn params_layout_matches_wgsl() {
    assert_eq!(std::mem::size_of::<Params>(), 272);
    assert_eq!(std::mem::offset_of!(Params, inverse_vp), 96);
    assert_eq!(std::mem::offset_of!(Params, eye), 224);
}

#[test]
fn executed_plan_matches_public_pass_order() {
    let source = serde_json::json!({"effects":[
        {"id":"glow","kind":"bloom","enabled":true,"params":[1.5,0.5,0.3,1,2,0,0,0,0,0,0,0,0,0,0,0],"quality":"high","operator":"display","lut":null},
        {"id":"noise","kind":"denoise","enabled":true,"params":[2,0.2,0.01,0.2,0,0,0,0,0,0,0,0,0,0,0,0],"quality":"medium","operator":"display","lut":null},
        {"id":"map","kind":"tonemap","enabled":true,"params":[0,4,0,1,0,3,0,0,0,0,0,0,0,0,0,0],"quality":"medium","operator":"aces","lut":null}
    ],"debug":{"view":"none","effectId":null,"hzbMip":0}});
    let config: PostFxConfig = serde_json::from_value(source).unwrap();
    config.validate().unwrap();
    let plans = plan::stages(&config);
    assert_eq!(
        plans.iter().map(|s| s.label.clone()).collect::<Vec<_>>(),
        config.pass_order()[3..config.pass_order().len() - 2]
    );
    // Tone mapping receives denoise, and bloom composite preserves its source.
    assert_eq!(plans[5].auxiliary, Some(4));
    assert_eq!(plans.last().unwrap().input, Some(7));
}
