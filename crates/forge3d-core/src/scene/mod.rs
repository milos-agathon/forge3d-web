use crate::error::{Forge3dError, Result};
use std::collections::{BTreeMap, BTreeSet};

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
    pub id: NodeId,
    pub name: String,
    pub kind: SceneNodeKind,
    pub transform: Transform,
    pub world_transform: glam::Mat4,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
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

    pub fn node_mut(&mut self, id: NodeId) -> Option<&mut SceneNode> {
        self.nodes.get_mut(&id)
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
        let roots = self.roots.clone();
        let mut visited = BTreeSet::new();
        for root in roots {
            self.update_world_recursive(root, glam::Mat4::IDENTITY, &mut visited)?;
        }
        Ok(())
    }

    pub fn visible_nodes(&mut self) -> Result<Vec<NodeId>> {
        self.update_world_transforms()?;
        let mut visible = Vec::new();
        let roots = self.roots.clone();
        for root in roots {
            self.collect_visible(root, true, &mut visible);
        }
        Ok(visible)
    }

    pub fn clear(&mut self) {
        self.nodes.clear();
        self.roots.clear();
    }

    fn update_world_recursive(
        &mut self,
        id: NodeId,
        parent_world: glam::Mat4,
        visited: &mut BTreeSet<NodeId>,
    ) -> Result<()> {
        if !visited.insert(id) {
            return invalid("scene", "cycle detected in scene graph");
        }
        let node = match self.nodes.get(&id) {
            Some(node) => node,
            None => return invalid("scene", "node does not exist"),
        };
        let world = parent_world * node.transform.matrix();
        let children = node.children.clone();
        self.nodes
            .get_mut(&id)
            .expect("node existence checked above")
            .world_transform = world;
        for child in children {
            self.update_world_recursive(child, world, visited)?;
        }
        Ok(())
    }

    fn collect_visible(&self, id: NodeId, parent_visible: bool, out: &mut Vec<NodeId>) {
        let node = match self.nodes.get(&id) {
            Some(node) => node,
            None => return,
        };
        let visible = parent_visible && node.visible;
        if visible {
            out.push(id);
        }
        for &child in &node.children {
            self.collect_visible(child, visible, out);
        }
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
