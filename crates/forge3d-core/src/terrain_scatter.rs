//! Browser-safe W09 population contracts. Matrices are row-major at the API boundary.
use glam::{Mat4, Vec3};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScatterMesh {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    #[serde(default)]
    pub uvs: Vec<f32>,
    #[serde(default)]
    pub tangents: Vec<f32>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScatterLevel {
    pub mesh: ScatterMesh,
    pub max_distance: Option<f32>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wind {
    pub enabled: bool,
    pub direction_degrees: f32,
    pub speed: f32,
    pub amplitude: f32,
    pub rigidity: f32,
    pub bend_start: f32,
    pub bend_extent: f32,
    pub gust_strength: f32,
    pub gust_frequency: f32,
    pub fade_start: f32,
    pub fade_end: f32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Blend {
    pub enabled: bool,
    pub bury_depth: f32,
    pub fade_distance: f32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contact {
    pub enabled: bool,
    pub distance: f32,
    pub strength: f32,
    pub vertical_weight: f32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hlod {
    pub distance: f32,
    pub cluster_radius: f32,
    pub simplify_ratio: f32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cluster {
    pub mesh: ScatterMesh,
    pub instance_indices: Vec<usize>,
    pub bounds: Bounds,
    pub center: [f32; 3],
    pub radius: f32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScatterBatch {
    #[serde(default)]
    pub material_index: u32,
    pub levels: Vec<ScatterLevel>,
    pub transforms: Vec<f32>,
    pub color: [f32; 4],
    pub name: String,
    pub max_draw_distance: Option<f32>,
    pub wind: Wind,
    pub hlod: Option<Hlod>,
    pub terrain_blend: Blend,
    pub terrain_contact: Contact,
    pub bounds: Bounds,
    pub clusters: Vec<Cluster>,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScatterStats {
    pub batch_count: u32,
    pub total_instances: u32,
    pub visible_instances: u32,
    pub culled_instances: u32,
    pub lod_instance_counts: Vec<u32>,
    pub hlod_cluster_draws: u32,
    pub hlod_covered_instances: u32,
    pub effective_draws: u32,
}
#[derive(Debug, Default)]
pub struct Selection {
    pub levels: Vec<Vec<usize>>,
    pub clusters: Vec<usize>,
    pub stats: ScatterStats,
}
pub fn row_matrix(row: &[f32]) -> Mat4 {
    Mat4::from_cols_array(row.try_into().expect("validated row matrix")).transpose()
}
fn finite(values: &[f32]) -> bool {
    values.iter().all(|x| x.is_finite())
}
fn positive(x: f32) -> bool {
    x.is_finite() && x > 0.0
}
impl ScatterMesh {
    pub fn validate(&self) -> Result<(), String> {
        let vertices = self.positions.len() / 3;
        if (!self.uvs.is_empty() && self.uvs.len() != vertices * 2)
            || (!self.tangents.is_empty() && self.tangents.len() != vertices * 4)
            || !finite(&self.uvs)
            || !finite(&self.tangents)
        {
            return Err("invalid mesh UV/tangent attributes".into());
        }
        if self.positions.is_empty()
            || !self.positions.len().is_multiple_of(3)
            || self.positions.len() != self.normals.len()
            || !finite(&self.positions)
            || !finite(&self.normals)
            || self.indices.is_empty()
            || !self.indices.len().is_multiple_of(3)
            || self
                .indices
                .iter()
                .any(|i| *i as usize >= self.positions.len() / 3)
        {
            return Err("invalid scatter mesh positions/normals/triangle indices".into());
        }
        Ok(())
    }
}
impl Bounds {
    fn valid(&self) -> bool {
        finite(&self.min) && finite(&self.max) && (0..3).all(|a| self.min[a] <= self.max[a])
    }
    fn contains_instance(
        &self,
        point: Vec3,
        row: &[f32],
        wind: &Wind,
        include_wind: bool,
        slack: f32,
    ) -> bool {
        let maximum = if include_wind && wind.enabled && wind.amplitude > 0.0 {
            wind.amplitude * (1.0 - wind.rigidity) + wind.gust_strength
        } else {
            0.0
        };
        (0..3).all(|a| {
            let displacement = maximum * row[a * 4].hypot(row[a * 4 + 2]);
            point[a] - displacement >= self.min[a] - slack
                && point[a] + displacement <= self.max[a] + slack
        })
    }
}
impl ScatterBatch {
    pub fn validate(&self) -> Result<(), String> {
        if self.material_index >= crate::materials::MAX_MATERIALS {
            return Err("material index exceeds scene limit".into());
        }
        if self.levels.is_empty()
            || self.levels.len() > 32
            || self.transforms.is_empty()
            || !self.transforms.len().is_multiple_of(16)
            || self.transforms.len() / 16 > 1_000_000
            || !finite(&self.transforms)
            || !finite(&self.color)
        {
            return Err("invalid scatter batch size or values".into());
        }
        let mut previous = 0.0;
        for (i, level) in self.levels.iter().enumerate() {
            level.mesh.validate()?;
            if let Some(d) = level.max_distance {
                if !positive(d) || d <= previous {
                    return Err("LOD distances must increase".into());
                }
                previous = d;
            } else if i + 1 != self.levels.len() {
                return Err("only the final LOD may be open-ended".into());
            }
        }
        for t in self.transforms.chunks_exact(16) {
            if t[12..] != [0.0, 0.0, 0.0, 1.0]
                || (!row_matrix(t).determinant().is_finite()
                    || row_matrix(t).determinant().abs() < 1e-12)
            {
                return Err(
                    "scatter transforms must be nonsingular affine row-major matrices".into(),
                );
            }
        }
        let w = &self.wind;
        if !finite(&[
            w.direction_degrees,
            w.speed,
            w.amplitude,
            w.rigidity,
            w.bend_start,
            w.bend_extent,
            w.gust_strength,
            w.gust_frequency,
            w.fade_start,
            w.fade_end,
        ]) || w.speed < 0.0
            || w.amplitude < 0.0
            || !(0.0..=1.0).contains(&w.rigidity)
            || !(0.0..=1.0).contains(&w.bend_start)
            || w.bend_extent <= 0.0
            || w.gust_strength < 0.0
            || w.gust_frequency < 0.0
            || w.fade_start < 0.0
            || w.fade_end < 0.0
        {
            return Err("invalid scatter wind settings".into());
        }
        if self.max_draw_distance.is_some_and(|d| !positive(d)) {
            return Err("maxDrawDistance must be positive".into());
        }
        let b = &self.terrain_blend;
        let c = &self.terrain_contact;
        if !finite(&[
            b.bury_depth,
            b.fade_distance,
            c.distance,
            c.strength,
            c.vertical_weight,
        ]) || b.bury_depth < 0.0
            || !positive(b.fade_distance)
            || !positive(c.distance)
            || !(0.0..=1.0).contains(&c.strength)
            || !(0.0..=1.0).contains(&c.vertical_weight)
        {
            return Err("invalid scatter blend/contact settings".into());
        }
        if let Some(h) = &self.hlod {
            if !positive(h.distance)
                || !positive(h.cluster_radius)
                || !positive(h.simplify_ratio)
                || h.simplify_ratio > 1.0
                || self.max_draw_distance.is_some_and(|d| h.distance >= d)
            {
                return Err("invalid HLOD policy".into());
            }
        }
        if self.hlod.is_none() && !self.clusters.is_empty() {
            return Err("clusters require HLOD policy".into());
        }
        if !self.bounds.valid() {
            return Err("invalid scatter population bounds".into());
        }
        let diagonal = Vec3::from(self.bounds.max).distance(self.bounds.min.into());
        let slack = diagonal * 1e-5;
        // Precompute local corners once per level, then validate the serialized bounds.
        let corners: Vec<Vec3> = self
            .levels
            .iter()
            .flat_map(|l| {
                let mut min = Vec3::splat(f32::INFINITY);
                let mut max = Vec3::splat(f32::NEG_INFINITY);
                for p in l.mesh.positions.chunks_exact(3) {
                    let p = Vec3::from_slice(p);
                    min = min.min(p);
                    max = max.max(p);
                }
                (0..8).map(move |bits| {
                    Vec3::new(
                        if bits & 1 == 0 { min.x } else { max.x },
                        if bits & 2 == 0 { min.y } else { max.y },
                        if bits & 4 == 0 { min.z } else { max.z },
                    )
                })
            })
            .collect();
        for row in self.transforms.chunks_exact(16) {
            let matrix = row_matrix(row);
            for corner in &corners {
                if !self.bounds.contains_instance(
                    matrix.transform_point3(*corner),
                    row,
                    &self.wind,
                    true,
                    slack,
                ) {
                    return Err("scatter bounds do not contain every LOD instance".into());
                }
            }
        }
        let mut membership = std::collections::BTreeSet::new();
        for cluster in &self.clusters {
            cluster.mesh.validate()?;
            if cluster.instance_indices.len() < 2
                || !finite(&cluster.center)
                || !cluster.radius.is_finite()
                || cluster.radius < 0.0
                || !cluster.bounds.valid()
            {
                return Err("invalid HLOD bounds".into());
            }
            for &id in &cluster.instance_indices {
                if id >= self.transforms.len() / 16 || !membership.insert(id) {
                    return Err("HLOD membership must be unique and in bounds".into());
                }
            }
            for &id in &cluster.instance_indices {
                let matrix = row_matrix(&self.transforms[id * 16..id * 16 + 16]);
                for corner in &corners {
                    if !cluster.bounds.contains_instance(
                        matrix.transform_point3(*corner),
                        &self.transforms[id * 16..id * 16 + 16],
                        &self.wind,
                        false,
                        slack,
                    ) {
                        return Err("HLOD bounds do not contain their instances".into());
                    }
                }
            }
            for point in cluster.mesh.positions.chunks_exact(3) {
                if !(0..3).all(|a| {
                    point[a] >= cluster.bounds.min[a] - slack
                        && point[a] <= cluster.bounds.max[a] + slack
                        && point[a] >= self.bounds.min[a] - slack
                        && point[a] <= self.bounds.max[a] + slack
                }) {
                    return Err("HLOD bounds do not contain their static mesh".into());
                }
                if Vec3::new(point[0], point[1], point[2]).distance(cluster.center.into())
                    > cluster.radius + slack
                {
                    return Err("HLOD sphere does not contain its static mesh".into());
                }
            }
        }
        Ok(())
    }
    pub fn select(&self, eye: Vec3) -> Selection {
        let mut selected = Selection {
            levels: vec![Vec::new(); self.levels.len()],
            stats: ScatterStats {
                batch_count: 1,
                total_instances: (self.transforms.len() / 16) as u32,
                lod_instance_counts: vec![0; self.levels.len()],
                ..Default::default()
            },
            ..Default::default()
        };
        let mut covered = std::collections::BTreeSet::new();
        let max = self.max_draw_distance.unwrap_or(f32::INFINITY);
        for (i, c) in self.clusters.iter().enumerate() {
            let surface_distance = eye.distance(c.center.into()) - c.radius;
            if surface_distance > self.hlod.as_ref().map_or(f32::INFINITY, |h| h.distance)
                && surface_distance < max
            {
                selected.clusters.push(i);
                covered.extend(c.instance_indices.iter().copied());
            }
        }
        for (i, t) in self.transforms.chunks_exact(16).enumerate() {
            let distance = eye.distance(Vec3::new(t[3], t[7], t[11]));
            if distance > max {
                selected.stats.culled_instances += 1;
                continue;
            }
            selected.stats.visible_instances += 1;
            if covered.contains(&i) {
                selected.stats.hlod_covered_instances += 1;
                continue;
            }
            let level = self
                .levels
                .iter()
                .position(|l| distance <= l.max_distance.unwrap_or(f32::INFINITY))
                .unwrap_or(self.levels.len() - 1);
            selected.levels[level].push(i);
            selected.stats.lod_instance_counts[level] += 1;
        }
        selected.stats.hlod_cluster_draws = selected.clusters.len() as u32;
        selected.stats.effective_draws = selected.levels.iter().filter(|l| !l.is_empty()).count()
            as u32
            + selected.stats.hlod_cluster_draws;
        selected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiny_population_slack_scales_with_actual_diagonal() {
        let mut b = batch();
        for index in [0, 5, 10] {
            b.transforms[index] = 0.01;
        }
        b.bounds.min = [-0.01, 0.0, 0.0];
        b.bounds.max = [0.01, 0.1, 0.0];
        b.validate().unwrap();
        let diagonal = Vec3::from(b.bounds.max).distance(b.bounds.min.into());
        b.bounds.max[1] -= diagonal * 1e-5 * 2.0;
        assert!(b.validate().unwrap_err().contains("contain"));
    }
    #[test]
    fn hlod_static_sphere_and_animated_population_bounds_are_independent() {
        let mut b = batch();
        b.transforms.extend_from_within(..16);
        b.wind.enabled = true;
        b.wind.amplitude = 20.0;
        b.wind.rigidity = 0.0;
        b.bounds.min = [-21.0, 0.0, -20.0];
        b.bounds.max = [21.0, 10.0, 20.0];
        b.hlod = Some(Hlod {
            distance: 30.0,
            cluster_radius: 64.0,
            simplify_ratio: 1.0,
        });
        b.clusters.push(Cluster {
            mesh: b.levels[1].mesh.clone(),
            instance_indices: vec![0, 1],
            bounds: b.bounds.clone(),
            center: [0.0; 3],
            radius: 10.1,
        });
        b.validate().unwrap();
        b.clusters[0].radius = 0.0;
        assert!(b.validate().unwrap_err().contains("static mesh"));
        b.clusters[0].radius = 100.0;
        b.clusters[0].mesh.positions[0] = 50.0;
        assert!(b.validate().unwrap_err().contains("static mesh"));
        b.clusters[0].mesh.positions[0] = -1.0;
        b.clusters[0].instance_indices.pop();
        assert!(b.validate().unwrap_err().contains("HLOD"));
    }

    fn batch() -> ScatterBatch {
        serde_json::from_value(serde_json::json!({
        "name":"test","levels":[{"mesh":{"positions":[-1,0,0,1,0,0,0,10,0],"normals":[0,0,1,0,0,1,0,0,1],"indices":[0,1,2]},"maxDistance":30},{"mesh":{"positions":[-1,0,0,1,0,0,0,10,0],"normals":[0,0,1,0,0,1,0,0,1],"indices":[0,1,2]}}],
        "transforms":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"color":[1,1,1,1],"maxDrawDistance":100,
        "wind":{"enabled":false,"directionDegrees":0,"speed":1,"amplitude":0,"rigidity":0.5,"bendStart":0,"bendExtent":1,"gustStrength":0,"gustFrequency":0.3,"fadeStart":0,"fadeEnd":0},
        "terrainBlend":{"enabled":false,"buryDepth":0.75,"fadeDistance":2.5},"terrainContact":{"enabled":false,"distance":3,"strength":0.35,"verticalWeight":0.65},"hlod":null,"clusters":[],"bounds":{"min":[-1,0,0],"max":[1,10,0]}
    })).unwrap()
    }
    #[test]
    fn native_lod_threshold_and_cull_boundary() {
        let b = batch();
        b.validate().unwrap();
        assert_eq!(
            b.select(Vec3::new(0.0, 0.0, 30.0))
                .stats
                .lod_instance_counts,
            vec![1, 0]
        );
        assert_eq!(
            b.select(Vec3::new(0.0, 0.0, 31.0))
                .stats
                .lod_instance_counts,
            vec![0, 1]
        );
        assert_eq!(
            b.select(Vec3::new(0.0, 0.0, 101.0)).stats.culled_instances,
            1
        );
    }
    #[test]
    fn raw_wasm_payload_rejects_bounds_and_wind_tampering() {
        let mut b = batch();
        b.bounds.max[1] = 9.0;
        assert!(b.validate().unwrap_err().contains("contain"));
        let mut b = batch();
        b.wind.speed = -1.0;
        assert!(b.validate().unwrap_err().contains("wind"));
        let mut b = batch();
        b.transforms[15] = 0.0;
        assert!(b.validate().unwrap_err().contains("affine"));
    }
    #[test]
    fn mesh_attributes_and_material_slots_are_bounded_at_wasm_boundary() {
        let mut b = batch();
        assert_eq!(b.material_index, 0);
        b.levels[0].mesh.uvs = vec![0.0; 6];
        b.levels[0].mesh.tangents = vec![1.0; 12];
        b.material_index = 255;
        b.validate().unwrap();
        b.material_index = 256;
        assert!(b.validate().is_err());
        b.material_index = 0;
        b.levels[0].mesh.uvs.pop();
        assert!(b.validate().is_err());
        b.levels[0].mesh.uvs.push(f32::NAN);
        assert!(b.validate().is_err());
    }
}
