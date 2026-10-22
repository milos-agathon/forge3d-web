//! Test-only complete production module graph under explicit browser feature selections.
use std::{collections::BTreeSet, fs, path::Path};
use syn::{parse::Parser, punctuated::Punctuated, Attribute, Item, Meta, Token};
fn enabled(meta: &Meta, features: &[&str]) -> bool {
    match meta {
        Meta::Path(path) => {
            if path.is_ident("test") {
                false
            } else if path.is_ident("debug_assertions") {
                true
            } else {
                panic!("unreviewed cfg predicate")
            }
        }
        Meta::NameValue(value) => {
            let syn::Expr::Lit(expr) = &value.value else {
                panic!("cfg literal expected")
            };
            let syn::Lit::Str(text) = &expr.lit else {
                panic!("cfg string expected")
            };
            let v = text.value();
            if value.path.is_ident("feature") {
                features.contains(&v.as_str()) || (v == "gpu" && features.contains(&"webgpu"))
            } else if value.path.is_ident("target_arch") {
                v == "wasm32"
            } else if value.path.is_ident("target_os") {
                v == "unknown"
            } else if value.path.is_ident("target_family") {
                v == "wasm"
            } else {
                panic!("unreviewed cfg key")
            }
        }
        Meta::List(list) => {
            let parts = Punctuated::<Meta, Token![,]>::parse_terminated
                .parse2(list.tokens.clone())
                .unwrap();
            if list.path.is_ident("all") {
                parts.iter().all(|m| enabled(m, features))
            } else if list.path.is_ident("any") {
                parts.iter().any(|m| enabled(m, features))
            } else if list.path.is_ident("not") {
                assert_eq!(parts.len(), 1);
                !enabled(&parts[0], features)
            } else {
                panic!("unreviewed cfg operator")
            }
        }
    }
}
fn active(attrs: &[Attribute], features: &[&str]) -> bool {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("cfg"))
        .all(|a| enabled(&a.parse_args::<Meta>().unwrap(), features))
}
pub(crate) fn module_names(source: &str, features: &[&str]) -> Vec<String> {
    syn::parse_file(source)
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| match item {
            Item::Mod(module) if active(&module.attrs, features) => Some(module.ident.to_string()),
            _ => None,
        })
        .collect()
}
fn graph(
    items: &[Item],
    directory: &Path,
    prefix: &str,
    features: &[&str],
    out: &mut BTreeSet<String>,
) {
    for item in items {
        if let Item::Mod(module) = item {
            if !active(&module.attrs, features) {
                continue;
            }
            let name = module.ident.to_string();
            let qualified = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}::{name}")
            };
            out.insert(qualified.clone());
            if let Some((_, items)) = &module.content {
                graph(items, &directory.join(&name), &qualified, features, out);
            } else {
                let explicit = module
                    .attrs
                    .iter()
                    .find(|a| a.path().is_ident("path"))
                    .map(|a| {
                        let Meta::NameValue(v) = &a.meta else {
                            panic!()
                        };
                        let syn::Expr::Lit(e) = &v.value else {
                            panic!()
                        };
                        let syn::Lit::Str(s) = &e.lit else { panic!() };
                        directory.join(s.value())
                    });
                let path = explicit.unwrap_or_else(|| {
                    let flat = directory.join(format!("{name}.rs"));
                    if flat.exists() {
                        flat
                    } else {
                        directory.join(&name).join("mod.rs")
                    }
                });
                let source =
                    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                let parsed = syn::parse_file(&source).unwrap();
                let child = if path.file_name().unwrap() == "mod.rs" {
                    path.parent().unwrap().to_path_buf()
                } else {
                    path.parent().unwrap().join(path.file_stem().unwrap())
                };
                graph(&parsed.items, &child, &qualified, features, out);
            }
        }
    }
}
#[test]
fn complete_production_exposure_matches_reviewed_inventory() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let source = fs::read_to_string(root.join("lib.rs")).unwrap();
    let parsed = syn::parse_file(&source).unwrap();
    let mut actual = String::new();
    for (label, features) in [
        ("default", vec![]),
        ("gpu", vec!["gpu"]),
        ("webgpu", vec!["gpu", "webgpu"]),
    ] {
        let mut modules = BTreeSet::new();
        graph(&parsed.items, &root, "", &features, &mut modules);
        actual.push_str(&format!("[{label}]\n"));
        for module in modules {
            actual.push_str(&format!("{module}\n"));
        }
    }
    if let Ok(path) = std::env::var("FORGE3D_EXPOSURE_REVIEW_OUTPUT") {
        fs::write(path, &actual).unwrap();
    }
    assert_eq!(
        actual,
        include_str!("feature-exposure.txt").replace("\r\n", "\n")
    );
}
#[test]
fn production_after_test_module_cannot_evade_exposure() {
    let source="pub mod safe; #[cfg(test)] mod tests {} pub mod forbidden; #[cfg(feature=\"webgpu\")] pub mod browser;";
    assert_eq!(module_names(source, &[]), ["safe", "forbidden"]);
    assert_eq!(
        module_names(source, &["webgpu"]),
        ["safe", "forbidden", "browser"]
    );
    assert_ne!(module_names(source, &[]), ["safe"]);
}
