use crate::error::{Forge3dError, Result};
use std::collections::BTreeSet;

mod compile;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ResourceId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PassId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceKind {
    Buffer {
        size: u64,
    },
    Texture {
        width: u32,
        height: u32,
        depth_or_layers: u32,
        bytes_per_texel: u32,
    },
}

impl ResourceKind {
    pub fn byte_size(&self) -> Result<u64> {
        match self {
            ResourceKind::Buffer { size } => {
                if *size == 0 {
                    return invalid("kind", "buffer size must be nonzero");
                }
                Ok(*size)
            }
            ResourceKind::Texture {
                width,
                height,
                depth_or_layers,
                bytes_per_texel,
            } => {
                if *width == 0 || *height == 0 || *depth_or_layers == 0 || *bytes_per_texel == 0 {
                    return invalid("kind", "texture dimensions must be nonzero");
                }
                u64::from(*width)
                    .checked_mul(u64::from(*height))
                    .and_then(|value| value.checked_mul(u64::from(*depth_or_layers)))
                    .and_then(|value| value.checked_mul(u64::from(*bytes_per_texel)))
                    .ok_or_else(|| Forge3dError::InvalidInput {
                        field: "kind".to_string(),
                        message: "texture byte size overflowed".to_string(),
                    })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceDescriptor {
    pub name: String,
    pub kind: ResourceKind,
    pub transient: bool,
    pub aliasable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassKind {
    Render,
    Compute,
    Copy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceAccess {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassDescriptor {
    pub name: String,
    pub kind: PassKind,
    pub reads: Vec<ResourceId>,
    pub writes: Vec<ResourceId>,
    pub depends_on: Vec<PassId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceBarrier {
    pub resource: ResourceId,
    pub before_pass: PassId,
    pub from: ResourceAccess,
    pub to: ResourceAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceAlias {
    pub logical: ResourceId,
    pub physical: ResourceId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderGraphMetrics {
    pub pass_count: usize,
    pub resource_count: usize,
    pub transient_count: usize,
    pub alias_count: usize,
    pub barrier_count: usize,
    pub logical_bytes: u64,
    pub physical_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionPlan {
    pub passes: Vec<PassId>,
    pub barriers: Vec<ResourceBarrier>,
    pub aliases: Vec<ResourceAlias>,
    pub metrics: RenderGraphMetrics,
}

#[derive(Debug)]
pub struct RenderGraph {
    pub(super) resources: Vec<ResourceDescriptor>,
    pub(super) passes: Vec<PassDescriptor>,
}

impl RenderGraph {
    pub fn new() -> Self {
        Self {
            resources: Vec::new(),
            passes: Vec::new(),
        }
    }

    pub fn add_resource(&mut self, descriptor: ResourceDescriptor) -> ResourceId {
        let id = ResourceId(self.resources.len() as u64);
        self.resources.push(descriptor);
        id
    }

    pub fn add_pass(&mut self, descriptor: PassDescriptor) -> Result<PassId> {
        let mut seen = BTreeSet::new();
        for &resource in descriptor.reads.iter().chain(descriptor.writes.iter()) {
            if resource.0 as usize >= self.resources.len() {
                return invalid("resources", "pass references an unknown resource");
            }
            if !seen.insert(resource) {
                return invalid(
                    "resources",
                    "resource listed more than once or in both reads and writes",
                );
            }
        }
        for &dependency in &descriptor.depends_on {
            if dependency.0 as usize >= self.passes.len() {
                return invalid("depends_on", "pass depends on an unknown pass");
            }
        }
        let id = PassId(self.passes.len() as u64);
        self.passes.push(descriptor);
        Ok(id)
    }

    pub fn add_dependency(&mut self, pass: PassId, depends_on: PassId) -> Result<()> {
        let pass_index = usize::try_from(pass.0)
            .ok()
            .filter(|&index| index < self.passes.len());
        let dependency_index = usize::try_from(depends_on.0)
            .ok()
            .filter(|&index| index < self.passes.len());
        let (pass_index, _dependency_index) = match (pass_index, dependency_index) {
            (Some(pass_index), Some(dependency_index)) => (pass_index, dependency_index),
            _ => return invalid("passes", "dependency references an unknown pass"),
        };
        let dependencies = &mut self.passes[pass_index].depends_on;
        if !dependencies.contains(&depends_on) {
            dependencies.push(depends_on);
        }
        Ok(())
    }

    pub fn clear(&mut self) {
        self.resources.clear();
        self.passes.clear();
    }
}

impl Default for RenderGraph {
    fn default() -> Self {
        Self::new()
    }
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}

#[cfg(test)]
mod alias_tests;
#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests;
