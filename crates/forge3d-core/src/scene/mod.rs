use crate::error::{Forge3dError, Result};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneNodeKind {
    Group,
    Terrain,
    GroundPlane,
    TextMesh,
    Overlay,
    Custom(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    pub translation: glam::Vec3,
    pub rotation: glam::Quat,
    pub scale: glam::Vec3,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            translation: glam::Vec3::ZERO,
            rotation: glam::Quat::IDENTITY,
            scale: glam::Vec3::ONE,
        }
    }
}

impl Transform {
    pub fn matrix(&self) -> glam::Mat4 {
        glam::Mat4::from_scale_rotation_translation(self.scale, self.rotation, self.translation)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneNode {
    id: NodeId,
    name: String,
    kind: SceneNodeKind,
    transform: Transform,
    world_transform: glam::Mat4,
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    visible: bool,
}

impl SceneNode {
    pub fn id(&self) -> NodeId {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn kind(&self) -> &SceneNodeKind {
        &self.kind
    }
    pub fn transform(&self) -> Transform {
        self.transform
    }
    pub fn parent(&self) -> Option<NodeId> {
        self.parent
    }
    pub fn children(&self) -> &[NodeId] {
        &self.children
    }
    pub fn visible(&self) -> bool {
        self.visible
    }
    pub fn world_transform(&self) -> glam::Mat4 {
        self.world_transform
    }
}
#[derive(Debug, Clone, Copy)]
pub struct TraversedNode {
    pub id: NodeId,
    pub world_transform: glam::Mat4,
    pub visible: bool,
}

#[derive(Debug)]
pub struct SceneGraph {
    nodes: BTreeMap<NodeId, SceneNode>,
    roots: Vec<NodeId>,
    next_id: u64,
}

impl SceneGraph {
    pub fn new() -> Self {
        Self {
            nodes: BTreeMap::new(),
            roots: Vec::new(),
            next_id: 0,
        }
    }

    pub fn create_node(&mut self, name: impl Into<String>, kind: SceneNodeKind) -> NodeId {
        let id = NodeId(self.next_id);
        self.next_id += 1;
        self.nodes.insert(
            id,
            SceneNode {
                id,
                name: name.into(),
                kind,
                transform: Transform::default(),
                world_transform: glam::Mat4::IDENTITY,
                parent: None,
                children: Vec::new(),
                visible: true,
            },
        );
        self.roots.push(id);
        id
    }

    pub fn node(&self, id: NodeId) -> Option<&SceneNode> {
        self.nodes.get(&id)
    }

    pub fn set_transform(&mut self, id: NodeId, transform: Transform) -> Result<()> {
        if !transform.matrix().is_finite() {
            return invalid("transform", "transform must be finite");
        }
        let Some(node) = self.nodes.get_mut(&id) else {
            return invalid("id", "node does not exist");
        };
        node.transform = transform;
        Ok(())
    }
    pub fn set_visible(&mut self, id: NodeId, visible: bool) -> Result<()> {
        let Some(node) = self.nodes.get_mut(&id) else {
            return invalid("id", "node does not exist");
        };
        node.visible = visible;
        Ok(())
    }
    /// Parent-first traversal owns hierarchical visibility and current world transforms.
    pub fn traversal(&self) -> Vec<TraversedNode> {
        let mut result = Vec::with_capacity(self.nodes.len());
        let mut stack: Vec<_> = self
            .roots
            .iter()
            .rev()
            .map(|id| (*id, glam::Mat4::IDENTITY, true))
            .collect();
        while let Some((id, parent_world, parent_visible)) = stack.pop() {
            let node = &self.nodes[&id];
            let world = parent_world * node.transform.matrix();
            let visible = parent_visible && node.visible;
            result.push(TraversedNode {
                id,
                world_transform: world,
                visible,
            });
            for child in node.children.iter().rev() {
                stack.push((*child, world, visible));
            }
        }
        result
    }

    pub fn roots(&self) -> &[NodeId] {
        &self.roots
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn set_parent(&mut self, child: NodeId, parent: Option<NodeId>) -> Result<()> {
        if !self.nodes.contains_key(&child) {
            return invalid("child", "node does not exist");
        }
        if let Some(parent_id) = parent {
            if parent_id == child {
                return invalid("parent", "node cannot parent itself");
            }
            if !self.nodes.contains_key(&parent_id) {
                return invalid("parent", "node does not exist");
            }
            let mut cursor = Some(parent_id);
            while let Some(id) = cursor {
                if id == child {
                    return invalid("parent", "reparenting would create an ancestor cycle");
                }
                cursor = self.nodes.get(&id).and_then(|node| node.parent);
            }
        }

        match self.nodes.get(&child).and_then(|node| node.parent) {
            Some(old_parent) => {
                if let Some(node) = self.nodes.get_mut(&old_parent) {
                    node.children.retain(|&id| id != child);
                }
            }
            None => self.roots.retain(|&id| id != child),
        }

        match parent {
            Some(parent_id) => {
                let parent_node = self
                    .nodes
                    .get_mut(&parent_id)
                    .expect("parent existence checked above");
                if !parent_node.children.contains(&child) {
                    parent_node.children.push(child);
                }
                self.nodes
                    .get_mut(&child)
                    .expect("child existence checked above")
                    .parent = Some(parent_id);
            }
            None => {
                self.nodes
                    .get_mut(&child)
                    .expect("child existence checked above")
                    .parent = None;
                if !self.roots.contains(&child) {
                    self.roots.push(child);
                }
            }
        }
        Ok(())
    }

    pub fn remove(&mut self, id: NodeId) -> Result<Vec<NodeId>> {
        if !self.nodes.contains_key(&id) {
            return invalid("id", "node does not exist");
        }
        let mut removed = Vec::new();
        collect_subtree(&self.nodes, id, &mut removed);

        match self.nodes.get(&id).and_then(|node| node.parent) {
            Some(parent_id) => {
                if let Some(parent) = self.nodes.get_mut(&parent_id) {
                    parent.children.retain(|&child| child != id);
                }
            }
            None => self.roots.retain(|&root| root != id),
        }

        for node_id in &removed {
            self.nodes.remove(node_id);
        }
        Ok(removed)
    }

    pub fn update_world_transforms(&mut self) -> Result<()> {
        for node in self.traversal() {
            self.nodes.get_mut(&node.id).unwrap().world_transform = node.world_transform;
        }
        Ok(())
    }
    pub fn visible_nodes(&mut self) -> Result<Vec<NodeId>> {
        let traversal = self.traversal();
        for node in &traversal {
            self.nodes.get_mut(&node.id).unwrap().world_transform = node.world_transform;
        }
        Ok(traversal
            .into_iter()
            .filter(|n| n.visible)
            .map(|n| n.id)
            .collect())
    }

    pub fn clear(&mut self) {
        self.nodes.clear();
        self.roots.clear();
    }
}

impl Default for SceneGraph {
    fn default() -> Self {
        Self::new()
    }
}

fn collect_subtree(nodes: &BTreeMap<NodeId, SceneNode>, id: NodeId, out: &mut Vec<NodeId>) {
    if let Some(node) = nodes.get(&id) {
        for &child in &node.children {
            collect_subtree(nodes, child, out);
        }
        out.push(id);
    }
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}

#[cfg(test)]
mod tests;
