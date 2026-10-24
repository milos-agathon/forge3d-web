//! Terrain layout eligibility and actual declared resource counts.
use super::shader_variants::ShaderFeatures;
mod layout;
use crate::error::{Forge3DErrorCode, WebError};
pub(super) use layout::terrain_layout_entries;
// W08 (E0): fragment-visible sampled-texture budget. Outside W08 the terrain
// pipeline samples 11 textures (group 0 heightmap/AO/sun/material albedo+aux,
// the LTC LUT, the IBL and shadow maps); only a textured material 0 adds the
// five scene `TextureSet` textures of group 2. The W08 slots stack on top:
// the height page table (binding 13), then the overlay array (14), then the
// VT page table (17). Untextured terrain therefore fits every W08 slot in
// the WebGPU default of 16; textured terrain needs 17 / 18 / 19.
pub(super) const TERRAIN_BASE_SAMPLED_TEXTURES: u32 = 11;
pub(super) const TERRAIN_SCENE_TEXTURE_SLOTS: u32 = 5;
pub(super) const W08_SAMPLED_TEXTURES_CLIPMAP: u32 =
    TERRAIN_BASE_SAMPLED_TEXTURES + TERRAIN_SCENE_TEXTURE_SLOTS;
pub(super) const W08_STORAGE_BUFFERS_VT: u32 = 3;
pub(super) const W09_STORAGE_BUFFERS_VT_PROBES: u32 = 4;

/// Which stacked W08 group-0 slots a terrain pipeline profile can declare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct W08Slots {
    /// Binding 13 (streamed height page table).
    pub(super) page_table: bool,
    /// Bindings 14-16 (overlay composite, sampler, uniform).
    pub(super) overlays: bool,
    /// Bindings 17-19 (VT page table, uniform, feedback ring).
    pub(super) vt: bool,
}

impl W08Slots {
    /// Slots that fit the negotiated limits for the untextured
    /// (`scene_textures == false`) or textured pipeline profile.
    pub(super) fn for_limits(sampled: u32, storage_buffers: u32, scene_textures: bool) -> Self {
        Self::for_limits_with_probes(sampled, storage_buffers, scene_textures, false)
    }

    pub(super) fn for_limits_with_probes(
        sampled: u32,
        storage_buffers: u32,
        scene_textures: bool,
        probes: bool,
    ) -> Self {
        let headroom = sampled.saturating_sub(Self::base(scene_textures));
        let vt_storage = if probes {
            W09_STORAGE_BUFFERS_VT_PROBES
        } else {
            W08_STORAGE_BUFFERS_VT
        };
        Self {
            page_table: headroom >= 1,
            overlays: headroom >= 2,
            vt: headroom >= 3 && storage_buffers >= vt_storage,
        }
    }

    pub(super) fn of_device(device: &wgpu::Device, scene_textures: bool, probes: bool) -> Self {
        let limits = device.limits();
        Self::for_limits_with_probes(
            limits.max_sampled_textures_per_shader_stage,
            limits.max_storage_buffers_per_shader_stage,
            scene_textures,
            probes,
        )
    }

    fn base(scene_textures: bool) -> u32 {
        TERRAIN_BASE_SAMPLED_TEXTURES
            + if scene_textures {
                TERRAIN_SCENE_TEXTURE_SLOTS
            } else {
                0
            }
    }

    /// Sampled-texture limit the `stack`-th W08 slot (1 = page table,
    /// 2 = overlays, 3 = VT) needs in the given profile.
    pub(super) fn required(scene_textures: bool, stack: u32) -> u32 {
        Self::base(scene_textures) + stack
    }

    /// Whether a group-0 binding belongs to this profile's layout.
    pub(super) fn keeps(self, binding: u32) -> bool {
        match binding {
            13 => self.page_table,
            14..=16 => self.overlays,
            17..=19 => self.vt,
            _ => true,
        }
    }
}

/// Typed `UNSUPPORTED_FEATURE` for a W08 feature the profile cannot bind.
pub(super) fn w08_limit_error(
    feature: &str,
    stack: u32,
    scene_textures: bool,
    sampled: u32,
    probes: bool,
) -> WebError {
    let storage = if stack == 3 {
        let required = if probes {
            W09_STORAGE_BUFFERS_VT_PROBES
        } else {
            W08_STORAGE_BUFFERS_VT
        };
        format!(" and maxStorageBuffersPerShaderStage >= {required}")
    } else {
        String::new()
    };
    let textured = if scene_textures {
        format!(
            " (terrain material 0 is textured, which binds {TERRAIN_SCENE_TEXTURE_SLOTS} more sampled textures)"
        )
    } else {
        String::new()
    };
    WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        format!(
            "{feature} requires maxSampledTexturesPerShaderStage >= {}{storage}, device has {sampled}{textured}",
            W08Slots::required(scene_textures, stack)
        ),
    )
}
#[derive(Clone, Copy, Debug)]
pub(super) struct ProfileKey {
    pub textured: bool,
    pub probes: bool,
    pub reflection: bool,
    pub aerial: bool,
}
impl ProfileKey {
    pub fn from_features(f: ShaderFeatures) -> Self {
        Self {
            textured: f.samples_scene_textures(),
            probes: f.probes(),
            reflection: f.masked_reflection(),
            aerial: f.aerial(),
        }
    }
    pub fn index(self) -> usize {
        usize::from(self.probes) * 8
            + usize::from(self.textured) * 4
            + usize::from(self.reflection) * 2
            + usize::from(self.aerial)
    }
    pub fn resolve(self, limits: &wgpu::Limits) -> ResolvedProfile {
        let slots = W08Slots::for_limits_with_probes(
            limits.max_sampled_textures_per_shader_stage,
            limits.max_storage_buffers_per_shader_stage,
            self.textured,
            self.probes,
        );
        let groups = [
            terrain_layout_entries(slots),
            if self.probes {
                super::lighting::lighting_layout_entries_with_probes()
            } else {
                super::lighting::lighting_layout_entries()
            },
            super::environment::reflection::masked_layout_entries(
                self.textured,
                self.reflection,
                self.aerial,
            ),
            super::ibl::ibl_layout_entries()
                .into_iter()
                .chain(super::shadows::shadow_layout_entries())
                .collect(),
        ];
        let mut sampled = 0;
        let mut storage = 0;
        let mut uniforms = 0;
        for e in groups
            .iter()
            .flatten()
            .filter(|e| e.visibility.contains(wgpu::ShaderStages::FRAGMENT))
        {
            let n = e.count.map_or(1, |n| n.get());
            match e.ty {
                wgpu::BindingType::Texture { .. } => sampled += n,
                wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { .. },
                    ..
                } => storage += n,
                wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    ..
                } => uniforms += n,
                _ => {}
            }
        }
        ResolvedProfile {
            slots,
            sampled,
            storage,
            uniforms,
        }
    }
}
#[derive(Debug)]
pub(super) struct ResolvedProfile {
    pub slots: W08Slots,
    pub sampled: u32,
    pub storage: u32,
    pub uniforms: u32,
}
impl ResolvedProfile {
    pub fn check(&self, limits: &wgpu::Limits) -> Result<(), WebError> {
        if self.sampled > limits.max_sampled_textures_per_shader_stage
            || self.storage > limits.max_storage_buffers_per_shader_stage
            || self.uniforms > limits.max_uniform_buffers_per_shader_stage
        {
            return Err(WebError::new(Forge3DErrorCode::UnsupportedFeature, format!("terrain binding profile requires {} sampled textures, {} storage buffers and {} uniform buffers", self.sampled, self.storage, self.uniforms)));
        }
        Ok(())
    }
}
pub(super) fn check_reflection(limits: &wgpu::Limits, textured: bool) -> Result<(), WebError> {
    // Preserve the full W08 profile threshold, including declared unused slots.
    let required = W08Slots::required(textured, 3) + 1;
    if limits.max_sampled_textures_per_shader_stage < required {
        return Err(WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            format!("masked-terrain reflection profile requires {required} sampled textures"),
        ));
    }
    ProfileKey {
        textured,
        probes: false,
        reflection: true,
        aerial: false,
    }
    .resolve(limits)
    .check(limits)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairwise_profiles_count_declared_bindings_and_preserve_limits() {
        for cap in [16, 17, 18, 19, 20, 24] {
            for textured in [false, true] {
                for probes in [false, true] {
                    for reflection in [false, true] {
                        for aerial in [false, true] {
                            for storage in [3, 4, 8] {
                                let limits = wgpu::Limits {
                                    max_sampled_textures_per_shader_stage: cap,
                                    max_storage_buffers_per_shader_stage: storage,
                                    ..wgpu::Limits::default()
                                };
                                let p = ProfileKey {
                                    textured,
                                    probes,
                                    reflection,
                                    aerial,
                                }
                                .resolve(&limits);
                                assert_eq!(
                                    p.sampled,
                                    W08Slots::base(textured)
                                        + u32::from(p.slots.page_table)
                                        + u32::from(p.slots.overlays)
                                        + u32::from(p.slots.vt)
                                        + u32::from(reflection)
                                );
                                assert!(p.storage <= storage);
                                assert_eq!(
                                    p.check(&limits).is_ok(),
                                    p.sampled <= cap
                                        && p.uniforms
                                            <= limits.max_uniform_buffers_per_shader_stage
                                );
                                if !textured && storage >= 4 {
                                    assert!(p.slots.page_table && p.slots.overlays && p.slots.vt);
                                }
                                assert_eq!(
                                    check_reflection(&limits, textured).is_ok(),
                                    cap >= if textured { 20 } else { 15 }
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
