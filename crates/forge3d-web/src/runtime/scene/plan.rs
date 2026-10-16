use std::collections::BTreeMap;

use forge3d_core::render_graph::{
    PassDescriptor, PassId, PassKind, RenderGraph, ResourceDescriptor, ResourceId, ResourceKind,
};

use super::parse::ParsedPass;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

#[derive(Debug, Clone)]
pub(super) struct CompiledScenePlan {
    pub pass_names: Vec<String>,
}

fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

fn resource_for(
    graph: &mut RenderGraph,
    ids: &mut BTreeMap<String, ResourceId>,
    name: &str,
) -> ResourceId {
    if let Some(id) = ids.get(name) {
        return *id;
    }
    let id = graph.add_resource(ResourceDescriptor {
        name: name.to_string(),
        kind: ResourceKind::Buffer { size: 4 },
        transient: true,
        aliasable: true,
    });
    ids.insert(name.to_string(), id);
    id
}

pub(super) fn compile_scene_plan(
    implicit_passes: &[&str],
    passes: &[ParsedPass],
    width: u32,
    height: u32,
) -> Result<CompiledScenePlan, WebError> {
    let mut graph = RenderGraph::new();
    let mut resource_ids = BTreeMap::new();
    resource_ids.insert(
        "color".to_string(),
        graph.add_resource(ResourceDescriptor {
            name: "color".to_string(),
            kind: ResourceKind::Texture {
                width,
                height,
                depth_or_layers: 1,
                bytes_per_texel: 4,
            },
            transient: false,
            aliasable: false,
        }),
    );
    resource_ids.insert(
        "depth".to_string(),
        graph.add_resource(ResourceDescriptor {
            name: "depth".to_string(),
            kind: ResourceKind::Texture {
                width,
                height,
                depth_or_layers: 1,
                bytes_per_texel: 4,
            },
            transient: true,
            aliasable: false,
        }),
    );

    let mut pass_ids: BTreeMap<String, PassId> = BTreeMap::new();
    let mut declaration_names = Vec::new();
    let mut previous_implicit: Option<PassId> = None;
    for name in implicit_passes {
        let writes = if *name == "overlay" {
            vec![resource_ids["color"]]
        } else {
            vec![resource_ids["color"], resource_ids["depth"]]
        };
        let depends_on = previous_implicit.into_iter().collect();
        let id = graph
            .add_pass(PassDescriptor {
                name: (*name).to_string(),
                kind: PassKind::Render,
                reads: Vec::new(),
                writes,
                depends_on,
            })
            .map_err(map_core_error)?;
        pass_ids.insert((*name).to_string(), id);
        declaration_names.push((*name).to_string());
        previous_implicit = Some(id);
    }

    for pass in passes {
        if pass_ids.contains_key(&pass.name) {
            return Err(invalid(format!("duplicate scene pass name {}", pass.name)));
        }
        let reads = pass
            .reads
            .iter()
            .map(|name| resource_for(&mut graph, &mut resource_ids, name))
            .collect();
        let writes = pass
            .writes
            .iter()
            .map(|name| resource_for(&mut graph, &mut resource_ids, name))
            .collect();
        let depends_on = pass
            .depends_on
            .iter()
            .map(|name| {
                pass_ids.get(name).copied().ok_or_else(|| {
                    invalid(format!(
                        "scene pass {} depends on unknown pass {name}",
                        pass.name
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let id = graph
            .add_pass(PassDescriptor {
                name: pass.name.clone(),
                kind: pass.kind,
                reads,
                writes,
                depends_on,
            })
            .map_err(map_core_error)?;
        pass_ids.insert(pass.name.clone(), id);
        declaration_names.push(pass.name.clone());
    }

    let plan = graph.compile().map_err(map_core_error)?;
    let pass_names = plan
        .passes
        .iter()
        .map(|id| declaration_names[id.0 as usize].clone())
        .collect();
    Ok(CompiledScenePlan { pass_names })
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge3d_core::render_graph::PassKind;

    fn custom_pass(name: &str, depends_on: &[&str]) -> ParsedPass {
        ParsedPass {
            name: name.to_string(),
            kind: PassKind::Render,
            reads: Vec::new(),
            writes: Vec::new(),
            depends_on: depends_on.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    #[test]
    fn implicit_passes_compile_in_canonical_order() {
        let plan = compile_scene_plan(
            &["terrain", "ground-plane", "text-mesh", "overlay"],
            &[],
            64,
            64,
        )
        .unwrap();
        assert_eq!(
            plan.pass_names,
            ["terrain", "ground-plane", "text-mesh", "overlay"]
        );
    }

    #[test]
    fn custom_passes_can_interleave_via_dependencies() {
        let plan = compile_scene_plan(
            &["terrain", "overlay"],
            &[custom_pass("post", &["overlay"])],
            64,
            64,
        )
        .unwrap();
        assert_eq!(plan.pass_names, ["terrain", "overlay", "post"]);
    }

    #[test]
    fn unknown_and_forward_dependencies_are_rejected() {
        let error = compile_scene_plan(&["terrain"], &[custom_pass("post", &["missing"])], 64, 64)
            .unwrap_err();
        assert_eq!(error.code(), Forge3DErrorCode::InvalidInput);

        let error = compile_scene_plan(
            &[],
            &[custom_pass("a", &["b"]), custom_pass("b", &[])],
            64,
            64,
        )
        .unwrap_err();
        assert_eq!(error.code(), Forge3DErrorCode::InvalidInput);
    }

    #[test]
    fn dependency_cycles_are_rejected() {
        let mut a = custom_pass("a", &[]);
        let mut b = custom_pass("b", &["a"]);
        a.writes.push("color".to_string());
        b.writes.push("color".to_string());
        assert!(compile_scene_plan(&[], &[a, b], 64, 64).is_ok());

        let first = ParsedPass {
            name: "first".to_string(),
            kind: PassKind::Render,
            reads: Vec::new(),
            writes: vec!["shared".to_string()],
            depends_on: Vec::new(),
        };
        let second = ParsedPass {
            name: "second".to_string(),
            kind: PassKind::Render,
            reads: vec!["shared".to_string()],
            writes: Vec::new(),
            depends_on: Vec::new(),
        };
        let plan = compile_scene_plan(&[], &[first, second], 64, 64).unwrap();
        assert_eq!(plan.pass_names, ["first", "second"]);
    }

    #[test]
    fn duplicate_pass_names_are_rejected() {
        let error =
            compile_scene_plan(&["terrain"], &[custom_pass("terrain", &[])], 64, 64).unwrap_err();
        assert_eq!(error.code(), Forge3DErrorCode::InvalidInput);
    }
}
