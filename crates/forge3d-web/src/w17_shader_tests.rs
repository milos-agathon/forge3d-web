fn literals(source: &str) -> Vec<&str> {
    source
        .split('`')
        .enumerate()
        .filter_map(|(i, s)| (i % 2 == 1).then_some(s))
        .collect()
}
fn validate(code: &str) {
    let module =
        naga::front::wgsl::parse_str(code).unwrap_or_else(|e| panic!("{}", e.emit_to_string(code)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap_or_else(|e| panic!("{e:?}"));
}
#[test]
fn w17_path_queries_radix_and_refit_validate() {
    let trace = literals(include_str!("../src-ts/trace-wgsl.ts"));
    validate(&format!("{}{}", trace[0], trace[1]));
    let query = literals(include_str!("../src-ts/trace-compute.ts"));
    validate(&format!("{}{}", trace[0], query[0]));
    let bvh = literals(include_str!("../src-ts/bvh-gpu.ts"));
    validate(bvh[0]);
}

#[test]
fn w17_storage_layouts_match_host_packing() {
    let trace = literals(include_str!("../src-ts/trace-wgsl.ts"));
    let module = naga::front::wgsl::parse_str(&format!("{}{}", trace[0], trace[1])).unwrap();
    for (name, expected) in [
        ("Params", 304),
        ("Hit", 64),
        ("Path", 192),
        ("Reservoir", 80),
        ("QueueItem", 128),
    ] {
        let ty = module
            .types
            .iter()
            .find(|(_, t)| t.name.as_deref() == Some(name))
            .unwrap()
            .1;
        match &ty.inner {
            naga::TypeInner::Struct { span, .. } => assert_eq!(*span, expected, "{name}"),
            _ => panic!("not a struct"),
        }
    }
    let storage = module
        .global_variables
        .iter()
        .filter(|(_, v)| matches!(v.space, naga::AddressSpace::Storage { .. }))
        .count();
    assert_eq!(storage, 8);
}
