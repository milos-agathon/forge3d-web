use super::{
    invalid, ExecutionPlan, PassId, RenderGraph, RenderGraphMetrics, ResourceAccess, ResourceAlias,
    ResourceBarrier, ResourceId, ResourceKind,
};
use crate::error::{Forge3dError, Result};
use std::collections::{BTreeMap, BTreeSet};

impl RenderGraph {
    pub fn compile(&self) -> Result<ExecutionPlan> {
        let pass_count = self.passes.len();
        let mut edges: BTreeSet<(usize, usize)> = BTreeSet::new();

        for (index, pass) in self.passes.iter().enumerate() {
            for dependency in &pass.depends_on {
                edges.insert((dependency.0 as usize, index));
            }
        }

        for resource in 0..self.resources.len() {
            let id = ResourceId(resource as u64);
            let mut last_writer: Option<usize> = None;
            let mut readers: Vec<usize> = Vec::new();
            for (index, pass) in self.passes.iter().enumerate() {
                if pass.reads.contains(&id) {
                    if let Some(writer) = last_writer {
                        edges.insert((writer, index));
                    }
                    readers.push(index);
                }
                if pass.writes.contains(&id) {
                    if let Some(writer) = last_writer {
                        edges.insert((writer, index));
                    }
                    for &reader in &readers {
                        edges.insert((reader, index));
                    }
                    last_writer = Some(index);
                    readers.clear();
                }
            }
        }

        let order = topological_order(pass_count, &edges)?;
        let mut position = vec![0usize; pass_count];
        for (slot, &pass_index) in order.iter().enumerate() {
            position[pass_index] = slot;
        }

        let barriers = self.barriers(&position);
        let (first, last, touched) = self.lifetimes(&position);
        let aliases = self.aliases(&first, &last, &touched);
        let metrics = self.metrics(&aliases, &barriers)?;

        Ok(ExecutionPlan {
            passes: order.iter().map(|&index| PassId(index as u64)).collect(),
            barriers,
            aliases,
            metrics,
        })
    }

    fn barriers(&self, position: &[usize]) -> Vec<ResourceBarrier> {
        let mut barriers = Vec::new();
        for resource in 0..self.resources.len() {
            let id = ResourceId(resource as u64);
            let mut accesses: Vec<(usize, ResourceAccess)> = Vec::new();
            for (index, pass) in self.passes.iter().enumerate() {
                if pass.reads.contains(&id) {
                    accesses.push((index, ResourceAccess::Read));
                }
                if pass.writes.contains(&id) {
                    accesses.push((index, ResourceAccess::Write));
                }
            }
            accesses.sort_by_key(|&(index, _)| position[index]);
            for pair in accesses.windows(2) {
                let (_, from) = pair[0];
                let (before, to) = pair[1];
                if from != to {
                    barriers.push(ResourceBarrier {
                        resource: id,
                        before_pass: PassId(before as u64),
                        from,
                        to,
                    });
                }
            }
        }
        barriers
            .sort_by_key(|barrier| (position[barrier.before_pass.0 as usize], barrier.resource.0));
        barriers
    }

    fn lifetimes(&self, position: &[usize]) -> (Vec<usize>, Vec<usize>, Vec<bool>) {
        let resource_count = self.resources.len();
        let mut first = vec![usize::MAX; resource_count];
        let mut last = vec![0usize; resource_count];
        let mut touched = vec![false; resource_count];
        for (index, pass) in self.passes.iter().enumerate() {
            for &resource in pass.reads.iter().chain(pass.writes.iter()) {
                let r = resource.0 as usize;
                touched[r] = true;
                first[r] = first[r].min(position[index]);
                last[r] = last[r].max(position[index]);
            }
        }
        (first, last, touched)
    }

    fn aliases(&self, first: &[usize], last: &[usize], touched: &[bool]) -> Vec<ResourceAlias> {
        struct Physical {
            representative: usize,
            kind: ResourceKind,
            first: usize,
            last: usize,
        }

        let mut physicals: Vec<Physical> = Vec::new();
        let mut aliases = Vec::new();
        for (index, descriptor) in self.resources.iter().enumerate() {
            if !(descriptor.transient && descriptor.aliasable && touched[index]) {
                continue;
            }
            let mut placed = false;
            for physical in &mut physicals {
                let disjoint = last[index] < physical.first || physical.last < first[index];
                if physical.kind == descriptor.kind && disjoint {
                    aliases.push(ResourceAlias {
                        logical: ResourceId(index as u64),
                        physical: ResourceId(physical.representative as u64),
                    });
                    physical.first = physical.first.min(first[index]);
                    physical.last = physical.last.max(last[index]);
                    placed = true;
                    break;
                }
            }
            if !placed {
                physicals.push(Physical {
                    representative: index,
                    kind: descriptor.kind.clone(),
                    first: first[index],
                    last: last[index],
                });
            }
        }
        aliases
    }

    fn metrics(
        &self,
        aliases: &[ResourceAlias],
        barriers: &[ResourceBarrier],
    ) -> Result<RenderGraphMetrics> {
        let mut logical_bytes = 0u64;
        for descriptor in &self.resources {
            logical_bytes = logical_bytes
                .checked_add(descriptor.kind.byte_size()?)
                .ok_or_else(|| overflow())?;
        }

        let aliased: BTreeSet<u64> = aliases.iter().map(|alias| alias.logical.0).collect();
        let mut physical_bytes = 0u64;
        for (index, descriptor) in self.resources.iter().enumerate() {
            if aliased.contains(&(index as u64)) {
                continue;
            }
            physical_bytes = physical_bytes
                .checked_add(descriptor.kind.byte_size()?)
                .ok_or_else(|| overflow())?;
        }

        Ok(RenderGraphMetrics {
            pass_count: self.passes.len(),
            resource_count: self.resources.len(),
            transient_count: self
                .resources
                .iter()
                .filter(|descriptor| descriptor.transient)
                .count(),
            alias_count: aliases.len(),
            barrier_count: barriers.len(),
            logical_bytes,
            physical_bytes,
        })
    }
}

pub(super) fn topological_order(
    pass_count: usize,
    edges: &BTreeSet<(usize, usize)>,
) -> Result<Vec<usize>> {
    let mut in_degree = vec![0usize; pass_count];
    let mut adjacency: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for &(from, to) in edges {
        if from >= pass_count || to >= pass_count {
            return invalid("passes", "edge references an unknown pass");
        }
        adjacency.entry(from).or_default().push(to);
        in_degree[to] += 1;
    }

    let mut ready: BTreeSet<usize> = (0..pass_count).filter(|&i| in_degree[i] == 0).collect();
    let mut order = Vec::with_capacity(pass_count);
    while let Some(&next) = ready.iter().next() {
        ready.remove(&next);
        order.push(next);
        if let Some(targets) = adjacency.get(&next) {
            for &to in targets {
                in_degree[to] -= 1;
                if in_degree[to] == 0 {
                    ready.insert(to);
                }
            }
        }
    }

    if order.len() != pass_count {
        return invalid("passes", "dependency cycle detected in render graph");
    }
    Ok(order)
}

fn overflow() -> Forge3dError {
    Forge3dError::ResourceLimitExceeded {
        resource: "render_graph".to_string(),
        message: "byte accounting overflowed u64".to_string(),
    }
}
