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
    for (name, span, expected) in [
        (
            "Params",
            304,
            vec![
                ("dims", 0),
                ("counts", 16),
                ("mode", 32),
                ("offsets0", 48),
                ("offsets1", 64),
                ("origin", 80),
                ("forward", 96),
                ("right", 112),
                ("up", 128),
                ("environment", 144),
                ("extra", 160),
                ("mediumMin", 176),
                ("mediumMax", 192),
                ("mediumA", 208),
                ("mediumS", 224),
                ("reuse", 240),
                ("thresholds", 256),
                ("sdfMin", 272),
                ("sdfMax", 288),
            ],
        ),
        (
            "Hit",
            64,
            vec![
                ("t", 0),
                ("id", 4),
                ("material", 8),
                ("steps", 12),
                ("bary", 16),
                ("p", 32),
                ("n", 48),
                ("front", 60),
            ],
        ),
        (
            "Path",
            192,
            vec![
                ("o", 0),
                ("d", 16),
                ("t", 32),
                ("c", 48),
                ("a", 64),
                ("n", 80),
                ("direct", 96),
                ("indirect", 112),
                ("emission", 128),
                ("bent", 144),
                ("tags", 160),
                ("identity", 176),
            ],
        ),
        (
            "Reservoir",
            80,
            vec![
                ("sample", 0),
                ("count", 4),
                ("weight", 8),
                ("importance", 12),
                ("age", 16),
                ("coords", 32),
                ("position", 48),
                ("normal", 64),
            ],
        ),
        (
            "QueueItem",
            128,
            vec![
                ("hit", 0),
                ("shadowO", 64),
                ("shadowD", 80),
                ("shadowC", 96),
                ("shadowTags", 112),
            ],
        ),
    ] {
        assert_layout(&module, name, span, &expected);
    }
    let bvh =
        naga::front::wgsl::parse_str(literals(include_str!("../src-ts/bvh-gpu.ts"))[0]).unwrap();
    assert_layout(&bvh, "Node", 48, &[("lo", 0), ("hi", 16), ("tags", 32)]);
    assert_layout(
        &bvh,
        "Triangle",
        64,
        &[("a", 0), ("b", 16), ("c", 32), ("tags", 48)],
    );
    assert_layout(
        &bvh,
        "Params",
        64,
        &[
            ("count", 0),
            ("shift", 4),
            ("blocks", 8),
            ("leaves", 12),
            ("lo", 16),
            ("hi", 32),
            ("level", 48),
            ("first", 52),
            ("nodes", 56),
            ("pad", 60),
        ],
    );
    let query_source = literals(include_str!("../src-ts/trace-compute.ts"));
    let query = naga::front::wgsl::parse_str(&format!("{}{}", trace[0], query_source[0])).unwrap();
    assert_layout(&query, "Query", 32, &[("o", 0), ("d", 16)]);
    assert_layout(
        &query,
        "Result",
        64,
        &[("p", 0), ("n", 16), ("bary", 32), ("tags", 48)],
    );
    let storage = module
        .global_variables
        .iter()
        .filter(|(_, v)| matches!(v.space, naga::AddressSpace::Storage { .. }))
        .count();
    assert_eq!(storage, 8);
}

fn assert_layout(module: &naga::Module, name: &str, expected_span: u32, expected: &[(&str, u32)]) {
    let ty = module
        .types
        .iter()
        .find(|(_, t)| t.name.as_deref() == Some(name))
        .unwrap()
        .1;
    let naga::TypeInner::Struct { span, members } = &ty.inner else {
        panic!("not a struct")
    };
    assert_eq!(*span, expected_span, "{name} size");
    let actual: Vec<_> = members
        .iter()
        .map(|m| (m.name.as_deref().unwrap(), m.offset))
        .collect();
    assert_eq!(actual, expected, "{name} member offsets");
}
