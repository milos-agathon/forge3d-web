//! Browser-safe SAH BVH and queries. Costs and bounds follow bf8db93's SAH builder;
//! nodes are rooted at zero, fixing the historical builder/refit root mismatch.
use glam::Vec3;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Triangle {
    pub v0: [f32; 3],
    pub v1: [f32; 3],
    pub v2: [f32; 3],
    pub id: u32,
    pub material_id: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Node {
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub left: u32,
    pub right: u32,
    pub first: u32,
    pub count: u32,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bvh {
    pub triangles: Vec<Triangle>,
    pub nodes: Vec<Node>,
    pub indices: Vec<u32>,
    pub max_depth: u32,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: u32,
    pub material_id: u32,
    pub t: f32,
    pub barycentric: [f32; 3],
}
fn bounds(t: &Triangle) -> (Vec3, Vec3) {
    let a = Vec3::from_array(t.v0);
    let b = Vec3::from_array(t.v1);
    let c = Vec3::from_array(t.v2);
    (a.min(b).min(c), a.max(b).max(c))
}
fn union(a: (Vec3, Vec3), b: (Vec3, Vec3)) -> (Vec3, Vec3) {
    (a.0.min(b.0), a.1.max(b.1))
}
fn empty() -> (Vec3, Vec3) {
    (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY))
}
fn area(b: (Vec3, Vec3)) -> f32 {
    let e = (b.1 - b.0).max(Vec3::ZERO);
    2. * (e.x * e.y + e.y * e.z + e.z * e.x)
}
impl Bvh {
    pub fn build(triangles: Vec<Triangle>, leaf: u32) -> Result<Self, String> {
        if triangles.is_empty() || !(1..=64).contains(&leaf) {
            return Err("Cannot build empty BVH or invalid leaf size".into());
        }
        let mut ids = std::collections::HashSet::new();
        for t in &triangles {
            if t.id == 0
                || t.id == u32::MAX
                || !ids.insert(t.id)
                || t.v0
                    .iter()
                    .chain(&t.v1)
                    .chain(&t.v2)
                    .any(|v| !v.is_finite())
            {
                return Err("Triangles require finite vertices and unique nonzero IDs".into());
            }
        }
        let boxes: Vec<_> = triangles.iter().map(bounds).collect();
        let mut tree = Self {
            indices: (0..triangles.len() as u32).collect(),
            triangles,
            nodes: Vec::new(),
            max_depth: 0,
        };
        tree.build_node(&boxes, 0, tree.indices.len(), 0, leaf);
        Ok(tree)
    }
    fn build_node(
        &mut self,
        boxes: &[(Vec3, Vec3)],
        first: usize,
        count: usize,
        depth: u32,
        leaf: u32,
    ) -> u32 {
        self.max_depth = self.max_depth.max(depth);
        let b = self.indices[first..first + count]
            .iter()
            .fold(empty(), |a, &i| union(a, boxes[i as usize]));
        let at = self.nodes.len() as u32;
        self.nodes.push(Node {
            min: b.0.to_array(),
            max: b.1.to_array(),
            left: 0,
            right: 0,
            first: first as u32,
            count: count as u32,
        });
        if count <= leaf as usize || depth >= 60 {
            return at;
        }
        let mut best_cost = count as f32;
        let mut best = None;
        for axis in 0..3 {
            let mut order = self.indices[first..first + count].to_vec();
            order.sort_by(|&a, &b| {
                let ca = (boxes[a as usize].0 + boxes[a as usize].1) * 0.5;
                let cb = (boxes[b as usize].0 + boxes[b as usize].1) * 0.5;
                ca[axis].total_cmp(&cb[axis]).then(a.cmp(&b))
            });
            let mut suffix = vec![empty(); count];
            let mut right = empty();
            for j in (0..count).rev() {
                right = union(right, boxes[order[j] as usize]);
                suffix[j] = right;
            }
            let mut left = empty();
            for j in 1..count {
                left = union(left, boxes[order[j - 1] as usize]);
                let ca = boxes[order[j - 1] as usize];
                let cb = boxes[order[j] as usize];
                if (ca.0[axis] + ca.1[axis]) * 0.5 == (cb.0[axis] + cb.1[axis]) * 0.5 {
                    continue;
                }
                let cost = 1.
                    + (area(left) * j as f32 + area(suffix[j]) * (count - j) as f32)
                        / area(b).max(1e-30);
                if cost < best_cost {
                    best_cost = cost;
                    best = Some((order.clone(), j));
                }
            }
        }
        if let Some((order, split)) = best {
            self.indices[first..first + count].copy_from_slice(&order);
            let left = self.build_node(boxes, first, split, depth + 1, leaf);
            let right = self.build_node(boxes, first + split, count - split, depth + 1, leaf);
            self.nodes[at as usize].left = left;
            self.nodes[at as usize].right = right;
            self.nodes[at as usize].count = 0;
            self.nodes[at as usize].first = 0;
        }
        at
    }
    pub fn refit(&mut self, triangles: Vec<Triangle>) -> Result<(), String> {
        if triangles.len() != self.triangles.len()
            || triangles
                .iter()
                .zip(&self.triangles)
                .any(|(a, b)| a.id != b.id)
        {
            return Err("Primitive count or ID mismatch".into());
        }
        if triangles.iter().any(|t| {
            t.v0.iter()
                .chain(&t.v1)
                .chain(&t.v2)
                .any(|v| !v.is_finite())
        }) {
            return Err("Non-finite vertices".into());
        }
        for i in (0..self.nodes.len()).rev() {
            let n = &self.nodes[i];
            let b = if n.count > 0 {
                self.indices[n.first as usize..(n.first + n.count) as usize]
                    .iter()
                    .fold(empty(), |a, &id| union(a, bounds(&triangles[id as usize])))
            } else {
                let l = &self.nodes[n.left as usize];
                let r = &self.nodes[n.right as usize];
                union(
                    (Vec3::from_array(l.min), Vec3::from_array(l.max)),
                    (Vec3::from_array(r.min), Vec3::from_array(r.max)),
                )
            };
            self.nodes[i].min = b.0.to_array();
            self.nodes[i].max = b.1.to_array();
        }
        self.triangles = triangles;
        Ok(())
    }
    pub fn intersect(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        tmin: f32,
        tmax: f32,
    ) -> Option<Hit> {
        let o = Vec3::from_array(origin);
        let d = Vec3::from_array(direction);
        let mut hit: Option<Hit> = None;
        let mut stack = vec![0usize];
        while let Some(i) = stack.pop() {
            let n = &self.nodes[i];
            let mut near = tmin;
            let mut far = hit.as_ref().map_or(tmax, |h| h.t);
            let mut valid = true;
            for a in 0..3 {
                if d[a] == 0. {
                    if o[a] < n.min[a] || o[a] > n.max[a] {
                        valid = false;
                        break;
                    }
                } else {
                    let x = (n.min[a] - o[a]) / d[a];
                    let y = (n.max[a] - o[a]) / d[a];
                    near = near.max(x.min(y));
                    far = far.min(x.max(y));
                }
            }
            if !valid || near > far {
                continue;
            }
            if n.count == 0 {
                stack.push(n.right as usize);
                stack.push(n.left as usize);
                continue;
            }
            for &id in &self.indices[n.first as usize..(n.first + n.count) as usize] {
                let t = &self.triangles[id as usize];
                let a = Vec3::from_array(t.v0);
                let e1 = Vec3::from_array(t.v1) - a;
                let e2 = Vec3::from_array(t.v2) - a;
                let p = d.cross(e2);
                let det = e1.dot(p);
                if det.abs() < 1e-8 {
                    continue;
                }
                let inv = 1. / det;
                let s = o - a;
                let u = s.dot(p) * inv;
                if !(0.0..=1.0).contains(&u) {
                    continue;
                }
                let q = s.cross(e1);
                let v = d.dot(q) * inv;
                if v < 0. || u + v > 1. {
                    continue;
                }
                let distance = e2.dot(q) * inv;
                if distance < tmin || distance > far {
                    continue;
                }
                if hit
                    .as_ref()
                    .is_none_or(|h| distance < h.t || (distance == h.t && t.id < h.id))
                {
                    hit = Some(Hit {
                        id: t.id,
                        material_id: t.material_id,
                        t: distance,
                        barycentric: [1. - (u + v), u, v],
                    });
                    far = distance;
                }
            }
        }
        hit
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn triangle(z: f32, id: u32) -> Triangle {
        Triangle {
            v0: [-1., -1., z],
            v1: [1., -1., z],
            v2: [0., 1., z],
            id,
            material_id: 0,
        }
    }
    #[test]
    fn hit_refit_and_zero_direction() {
        let mut b = Bvh::build(vec![triangle(0., 1), triangle(-2., 2)], 1).unwrap();
        let h = b.intersect([0., 0., 5.], [0., 0., -1.], 0., 100.).unwrap();
        assert_eq!(h.id, 1);
        assert_eq!(h.t, 5.);
        assert_eq!(h.barycentric, [0.25, 0.25, 0.5]);
        b.refit(vec![triangle(-3., 1), triangle(-2., 2)]).unwrap();
        assert_eq!(
            b.intersect([0., 0., 5.], [0., 0., -1.], 0., 100.)
                .unwrap()
                .id,
            2
        );
    }
    #[test]
    fn reject_nonfinite_and_count_change() {
        assert!(Bvh::build(vec![], 4).is_err());
        assert!(Bvh::build(vec![triangle(0., u32::MAX)], 4).is_err());
        assert!(Bvh::build(vec![triangle(0., u32::MAX - 1)], 4).is_ok());
        let mut b = Bvh::build(vec![triangle(0., 1)], 4).unwrap();
        assert!(b.refit(vec![]).is_err());
    }
}
