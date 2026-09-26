use crate::error::{Forge3dError, Result};

pub const MAX_MATERIALS: u32 = 256;
pub const PACKED_MATERIAL_BYTES: usize = 64;
pub const MATERIAL_UNIFORM_BYTES: usize = 16;

// Route kinds packed into PackedMaterial::route_kind for GPU diagnostics.
pub const ROUTE_EXACT: u32 = 0;
pub const ROUTE_ALIAS: u32 = 1;
pub const ROUTE_APPROXIMATION: u32 = 2;

// PackedMaterial::flags bits 0-4 mark base-color/normal/MR/occlusion/emissive texture presence.
pub const MATERIAL_FLAG_BASE_COLOR_TEXTURE: u32 = 1;
pub const MATERIAL_FLAG_NORMAL_TEXTURE: u32 = 2;
pub const MATERIAL_FLAG_METALLIC_ROUGHNESS_TEXTURE: u32 = 4;
pub const MATERIAL_FLAG_OCCLUSION_TEXTURE: u32 = 8;
pub const MATERIAL_FLAG_EMISSIVE_TEXTURE: u32 = 16;
pub const MATERIAL_TEXTURE_FLAGS_MASK: u32 = 0x1f;

pub const CANONICAL_BRDF_MODELS: [&str; 13] = [
    "lambert",
    "phong",
    "blinn-phong",
    "oren-nayar",
    "cooktorrance-ggx",
    "cooktorrance-beckmann",
    "disney-principled",
    "ashikhmin-shirley",
    "ward",
    "toon",
    "minnaert",
    "subsurface",
    "hair",
];

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrdfModel {
    Lambert = 0,
    Phong = 1,
    BlinnPhong = 2,
    OrenNayar = 3,
    CookTorranceGgx = 4,
    CookTorranceBeckmann = 5,
    DisneyPrincipled = 6,
    AshikhminShirley = 7,
    Ward = 8,
    Toon = 9,
    Minnaert = 10,
    Subsurface = 11,
    Hair = 12,
}

impl BrdfModel {
    pub const ALL: [BrdfModel; 13] = [
        BrdfModel::Lambert,
        BrdfModel::Phong,
        BrdfModel::BlinnPhong,
        BrdfModel::OrenNayar,
        BrdfModel::CookTorranceGgx,
        BrdfModel::CookTorranceBeckmann,
        BrdfModel::DisneyPrincipled,
        BrdfModel::AshikhminShirley,
        BrdfModel::Ward,
        BrdfModel::Toon,
        BrdfModel::Minnaert,
        BrdfModel::Subsurface,
        BrdfModel::Hair,
    ];

    pub fn name(self) -> &'static str {
        CANONICAL_BRDF_MODELS[self as usize]
    }

    pub fn from_name(name: &str) -> Option<BrdfModel> {
        CANONICAL_BRDF_MODELS
            .iter()
            .position(|canonical| *canonical == name)
            .map(|index| BrdfModel::ALL[index])
    }

    pub fn effective(self) -> BrdfModel {
        match self {
            BrdfModel::BlinnPhong => BrdfModel::Phong,
            BrdfModel::Subsurface => BrdfModel::DisneyPrincipled,
            BrdfModel::Hair => BrdfModel::AshikhminShirley,
            model => model,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrdfImplementation {
    Exact,
    Alias,
    Approximation,
}

impl BrdfImplementation {
    pub fn route_kind(self) -> u32 {
        match self {
            BrdfImplementation::Exact => ROUTE_EXACT,
            BrdfImplementation::Alias => ROUTE_ALIAS,
            BrdfImplementation::Approximation => ROUTE_APPROXIMATION,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BrdfRoute {
    pub requested: String,
    pub model: &'static str,
    pub effective_model: &'static str,
    pub implementation: BrdfImplementation,
    pub diagnostic: Option<String>,
}

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct PackedMaterial {
    pub brdf: u32,
    pub effective_brdf: u32,
    pub route_kind: u32,
    pub flags: u32,
    pub base_color: [f32; 4],
    pub surface: [f32; 4],
    pub lobes: [f32; 4],
}

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct MaterialUniform {
    pub material_count: u32,
    pub default_index: u32,
    pub _pad: [u32; 2],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    pub id: String,
    pub route: BrdfRoute,
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub sheen: f32,
    pub clearcoat: f32,
    pub subsurface: f32,
    pub anisotropy: f32,
    pub flags: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialSlot {
    pub slot: String,
    pub index: u32,
    pub material: Material,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialState {
    pub max_materials: u32,
    pub slots: Vec<MaterialSlot>,
}

const BRDF_ALIASES: [(&str, &str); 14] = [
    ("blinnphong", "blinn-phong"),
    ("orennayar", "oren-nayar"),
    ("cook-torrance-ggx", "cooktorrance-ggx"),
    ("cooktorranceggx", "cooktorrance-ggx"),
    ("ggx", "cooktorrance-ggx"),
    ("cook-torrance-beckmann", "cooktorrance-beckmann"),
    ("cooktorrancebeckmann", "cooktorrance-beckmann"),
    ("beckmann", "cooktorrance-beckmann"),
    ("disneyprincipled", "disney-principled"),
    ("disney", "disney-principled"),
    ("ashikhminshirley", "ashikhmin-shirley"),
    ("sss", "subsurface"),
    ("kajiyakay", "hair"),
    ("kajiya-kay", "hair"),
];

fn normalize_brdf_name(requested: &str) -> String {
    requested
        .split(|c: char| c == '_' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
}

/// Native `normalize_key` (1f4084a:src/render/params/common.rs): trim,
/// lowercase and drop '-', '_', ' ' and '.'.
fn native_brdf_key(requested: &str) -> String {
    requested
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| !matches!(c, '-' | '_' | ' ' | '.'))
        .collect()
}

/// Native `BrdfModel::from_str` keys after `normalize_key`.
fn native_brdf_model(requested: &str) -> Option<&'static str> {
    let key = native_brdf_key(requested);
    if let Some(canonical) = CANONICAL_BRDF_MODELS
        .iter()
        .find(|canonical| native_brdf_key(canonical) == key)
    {
        return Some(canonical);
    }
    match key.as_str() {
        "ggx" => Some("cooktorrance-ggx"),
        "beckmann" => Some("cooktorrance-beckmann"),
        "disney" => Some("disney-principled"),
        "sss" => Some("subsurface"),
        "kajiyakay" => Some("hair"),
        _ => None,
    }
}

fn base_route(model: &'static str) -> (BrdfImplementation, Option<String>, &'static str) {
    match model {
        "blinn-phong" => (
            BrdfImplementation::Alias,
            Some("blinn-phong is rendered by the normalized phong route".to_string()),
            "phong",
        ),
        "subsurface" => (
            BrdfImplementation::Approximation,
            Some(
                "subsurface is approximated by disney-principled with the subsurface lobe"
                    .to_string(),
            ),
            "disney-principled",
        ),
        "hair" => (
            BrdfImplementation::Approximation,
            Some("hair is approximated by ashikhmin-shirley anisotropy".to_string()),
            "ashikhmin-shirley",
        ),
        _ => (BrdfImplementation::Exact, None, model),
    }
}

pub fn resolve_brdf(requested: &str) -> Result<BrdfRoute> {
    if requested.is_empty() {
        return Err(invalid("material.brdf", "must be a nonempty string"));
    }
    let normalized = normalize_brdf_name(requested);
    let model: &'static str = if let Some(canonical) = CANONICAL_BRDF_MODELS
        .iter()
        .find(|canonical| **canonical == normalized)
    {
        canonical
    } else {
        BRDF_ALIASES
            .iter()
            .find(|(alias, _)| *alias == normalized)
            .map(|(_, model)| *model)
            .or_else(|| native_brdf_model(requested))
            .ok_or_else(|| invalid("material.brdf", format!("unknown brdf model '{requested}'")))?
    };
    let (base_implementation, base_diagnostic, effective_model) = base_route(model);
    let input_alias = normalized != model;
    let (implementation, diagnostic) = if !input_alias {
        (base_implementation, base_diagnostic)
    } else if base_implementation == BrdfImplementation::Exact {
        (
            BrdfImplementation::Alias,
            Some(format!("{normalized} is an alias for {model}")),
        )
    } else {
        (
            base_implementation,
            Some(format!(
                "{}; input alias {normalized} resolves to {model}",
                base_diagnostic.unwrap_or_default()
            )),
        )
    };
    Ok(BrdfRoute {
        requested: requested.to_string(),
        model,
        effective_model,
        implementation,
        diagnostic,
    })
}

pub fn default_material() -> Material {
    Material {
        id: "default".to_string(),
        route: resolve_brdf("cooktorrance-ggx").expect("canonical model resolves"),
        base_color: [1.0, 1.0, 1.0, 1.0],
        metallic: 0.0,
        roughness: 0.5,
        sheen: 0.0,
        clearcoat: 0.0,
        subsurface: 0.0,
        anisotropy: 0.0,
        flags: 0,
    }
}

pub fn default_state() -> MaterialState {
    MaterialState {
        max_materials: MAX_MATERIALS,
        slots: vec![MaterialSlot {
            slot: "default".to_string(),
            index: 0,
            material: default_material(),
        }],
    }
}

impl Material {
    pub fn validated(&self) -> Result<Material> {
        if self.id.is_empty() {
            return Err(invalid("material.id", "must be a nonempty string"));
        }
        let expected_route = resolve_brdf(&self.route.requested)?;
        if expected_route != self.route {
            return Err(invalid(
                "material.route",
                "must be produced by resolve_brdf for the requested model",
            ));
        }
        for (channel, component) in self.base_color.iter().enumerate() {
            if !component.is_finite() || !(0.0..=1.0).contains(component) {
                return Err(invalid(
                    "material.baseColor",
                    format!("channel {channel} must be finite and in the 0..1 range"),
                ));
            }
        }
        for (value, field) in [
            (self.metallic, "material.metallic"),
            (self.roughness, "material.roughness"),
            (self.sheen, "material.sheen"),
            (self.clearcoat, "material.clearcoat"),
            (self.subsurface, "material.subsurface"),
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(invalid(field, "must be finite and in the 0..1 range"));
            }
        }
        if !self.anisotropy.is_finite() || !(-1.0..=1.0).contains(&self.anisotropy) {
            return Err(invalid(
                "material.anisotropy",
                "must be finite and in the -1..1 range",
            ));
        }
        if self.flags & !MATERIAL_TEXTURE_FLAGS_MASK != 0 {
            return Err(invalid(
                "material.flags",
                "only texture presence bits 0..4 may be set",
            ));
        }
        Ok(self.clone())
    }

    /// Pack a validated material into GPU lanes. Call `validated()` first.
    pub fn pack(&self) -> PackedMaterial {
        let model = BrdfModel::from_name(self.route.model).unwrap_or(BrdfModel::CookTorranceGgx);
        let effective =
            BrdfModel::from_name(self.route.effective_model).unwrap_or(model.effective());
        PackedMaterial {
            brdf: model as u32,
            effective_brdf: effective as u32,
            route_kind: self.route.implementation.route_kind(),
            flags: self.flags & MATERIAL_TEXTURE_FLAGS_MASK,
            base_color: self.base_color,
            surface: [self.metallic, self.roughness, self.sheen, self.clearcoat],
            lobes: [self.subsurface, self.anisotropy, 0.0, 0.0],
        }
    }
}

impl MaterialState {
    pub fn validated(&self) -> Result<MaterialState> {
        if self.max_materials == 0 || self.max_materials > MAX_MATERIALS {
            return Err(invalid(
                "materials.maxMaterials",
                "must be an integer between 1 and 256",
            ));
        }
        if self.slots.len() > self.max_materials as usize {
            return Err(invalid("materials", "material count exceeds maxMaterials"));
        }
        let mut default_seen = false;
        for (position, slot) in self.slots.iter().enumerate() {
            if slot.slot.is_empty() {
                return Err(invalid("materials.slot", "slot names must be nonempty"));
            }
            if slot.index >= self.max_materials {
                return Err(invalid(
                    "materials.slot",
                    "slot index must be below maxMaterials",
                ));
            }
            if slot.slot == "default" {
                if slot.index != 0 {
                    return Err(invalid(
                        "materials.default",
                        "the default slot must sit at index 0",
                    ));
                }
                default_seen = true;
            }
            if self.slots[..position]
                .iter()
                .any(|other| other.slot == slot.slot)
            {
                return Err(invalid("materials.slot", "slot names must be unique"));
            }
            if self.slots[..position]
                .iter()
                .any(|other| other.index == slot.index)
            {
                return Err(invalid("materials.slot", "slot indices must be unique"));
            }
            slot.material.validated()?;
        }
        if !default_seen {
            return Err(invalid(
                "materials.default",
                "a default slot at index 0 is required",
            ));
        }
        Ok(self.clone())
    }

    /// Pack validated materials indexed by slot index. Call `validated()` first.
    pub fn pack_materials(&self) -> Vec<PackedMaterial> {
        let lane_count = self
            .slots
            .iter()
            .map(|slot| slot.index)
            .max()
            .map(|index| index + 1)
            .unwrap_or(1) as usize;
        let mut packed = vec![
            PackedMaterial {
                brdf: 0,
                effective_brdf: 0,
                route_kind: 0,
                flags: 0,
                base_color: [0.0; 4],
                surface: [0.0; 4],
                lobes: [0.0; 4],
            };
            lane_count
        ];
        for slot in &self.slots {
            packed[slot.index as usize] = slot.material.pack();
        }
        packed
    }

    pub fn uniform(&self) -> MaterialUniform {
        let material_count = self
            .slots
            .iter()
            .map(|slot| slot.index)
            .max()
            .map(|index| index + 1)
            .unwrap_or(0);
        let default_index = self
            .slots
            .iter()
            .find(|slot| slot.slot == "default")
            .map(|slot| slot.index)
            .unwrap_or(0);
        MaterialUniform {
            material_count,
            default_index,
            _pad: [0, 0],
        }
    }
}

fn saturate(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

fn normalize_or(vector: [f32; 3], fallback: [f32; 3]) -> [f32; 3] {
    let length = dot3(vector, vector).sqrt();
    if length.is_finite() && length > 1e-6 {
        scale3(vector, 1.0 / length)
    } else {
        fallback
    }
}

fn half_vector(view: [f32; 3], light: [f32; 3]) -> [f32; 3] {
    normalize_or(add3(view, light), [0.0, 1.0, 0.0])
}

fn f0_color(material: &Material) -> [f32; 3] {
    let base = material.base_color;
    [
        0.04 + (base[0] - 0.04) * material.metallic,
        0.04 + (base[1] - 0.04) * material.metallic,
        0.04 + (base[2] - 0.04) * material.metallic,
    ]
}

fn schlick(cos_theta: f32, f0: [f32; 3]) -> [f32; 3] {
    let factor = (1.0 - saturate(cos_theta)).powi(5);
    [
        f0[0] + factor * (1.0 - f0[0]),
        f0[1] + factor * (1.0 - f0[1]),
        f0[2] + factor * (1.0 - f0[2]),
    ]
}

fn diffuse_lambert(material: &Material) -> [f32; 3] {
    let scale = (1.0 - material.metallic) / std::f32::consts::PI;
    [
        material.base_color[0] * scale,
        material.base_color[1] * scale,
        material.base_color[2] * scale,
    ]
}

fn ggx_distribution(roughness: f32, ndoth: f32) -> f32 {
    let alpha = roughness.max(1e-3);
    let alpha2 = alpha * alpha;
    let denom = ndoth * ndoth * (alpha2 - 1.0) + 1.0;
    alpha2 / (std::f32::consts::PI * (denom * denom).max(1e-12))
}

fn beckmann_distribution(roughness: f32, ndoth: f32) -> f32 {
    let alpha2 = (roughness * roughness).max(1e-4);
    let nh2 = (ndoth * ndoth).max(1e-8);
    let tan2 = (1.0 - nh2) / nh2;
    (-tan2 / alpha2).exp() / (std::f32::consts::PI * alpha2 * nh2 * nh2)
}

fn smith_g1(ndotx: f32, k: f32) -> f32 {
    ndotx / (ndotx * (1.0 - k) + k).max(1e-6)
}

fn cook_torrance(
    material: &Material,
    n: [f32; 3],
    v: [f32; 3],
    l: [f32; 3],
    beckmann: bool,
) -> [f32; 3] {
    let h = half_vector(v, l);
    let ndoth = saturate(dot3(n, h));
    let ndotl = dot3(n, l).max(1e-6);
    let ndotv = dot3(n, v).max(1e-6);
    let vdoth = saturate(dot3(v, h));
    let d = if beckmann {
        beckmann_distribution(material.roughness, ndoth)
    } else {
        ggx_distribution(material.roughness, ndoth)
    };
    let k = material.roughness.max(1e-3) * 0.5;
    let g = (smith_g1(ndotl, k) * smith_g1(ndotv, k)).min(1.0);
    let f = schlick(vdoth, f0_color(material));
    let spec_scale = (d * g) / (4.0 * ndotv * ndotl);
    let diffuse = diffuse_lambert(material);
    [
        diffuse[0] * (1.0 - f[0]) + f[0] * spec_scale,
        diffuse[1] * (1.0 - f[1]) + f[1] * spec_scale,
        diffuse[2] * (1.0 - f[2]) + f[2] * spec_scale,
    ]
}

fn oren_nayar(material: &Material, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let ndotl = saturate(dot3(n, l));
    let ndotv = saturate(dot3(n, v));
    let sigma2 = material.roughness * material.roughness;
    let a = 1.0 - sigma2 / (2.0 * (sigma2 + 0.33));
    let b = 0.45 * sigma2 / (sigma2 + 0.09);
    let lt = sub3(l, scale3(n, ndotl));
    let vt = sub3(v, scale3(n, ndotv));
    let lt_len = dot3(lt, lt).sqrt();
    let vt_len = dot3(vt, vt).sqrt();
    let cos_phi = if lt_len * vt_len > 1e-8 {
        dot3(lt, vt) / (lt_len * vt_len)
    } else {
        0.0
    };
    let theta_l = ndotl.clamp(-1.0, 1.0).acos();
    let theta_v = ndotv.clamp(-1.0, 1.0).acos();
    let (alpha, beta) = if theta_l >= theta_v {
        (theta_l, theta_v)
    } else {
        (theta_v, theta_l)
    };
    let sin_alpha_tan_beta = alpha.sin() * beta.tan();
    let term = a + b * cos_phi.max(0.0) * sin_alpha_tan_beta.max(0.0);
    let scale = term.max(0.0) / std::f32::consts::PI;
    [
        material.base_color[0] * scale,
        material.base_color[1] * scale,
        material.base_color[2] * scale,
    ]
}

fn phong(material: &Material, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let h = half_vector(v, l);
    let ndoth = saturate(dot3(n, h));
    let vdoth = saturate(dot3(v, h));
    let exponent = (2.0 / material.roughness.powi(4).max(1e-4) - 2.0).clamp(1.0, 4096.0);
    let f = schlick(vdoth, f0_color(material));
    let spec_scale = (exponent + 2.0) / (2.0 * std::f32::consts::PI) * ndoth.powf(exponent);
    let diffuse = diffuse_lambert(material);
    [
        diffuse[0] * (1.0 - f[0]) + f[0] * spec_scale,
        diffuse[1] * (1.0 - f[1]) + f[1] * spec_scale,
        diffuse[2] * (1.0 - f[2]) + f[2] * spec_scale,
    ]
}

fn disney_principled(material: &Material, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let h = half_vector(v, l);
    let ndotl = saturate(dot3(n, l));
    let ndotv = saturate(dot3(n, v));
    let ndoth = saturate(dot3(n, h));
    let vdoth = saturate(dot3(v, h));
    let fl = (1.0 - ndotl).powi(5);
    let fv = (1.0 - ndotv).powi(5);
    let fd90 = 0.5 + 2.0 * material.roughness * vdoth * vdoth;
    let diffuse_weight = (1.0 + (fd90 - 1.0) * fl) * (1.0 + (fd90 - 1.0) * fv);
    let fss90 = vdoth * vdoth * material.roughness;
    let subsurface_weight = (1.0 + (fss90 - 1.0) * fl) * (1.0 + (fss90 - 1.0) * fv);
    let diffuse_scale = (1.0 - material.metallic) / std::f32::consts::PI
        * ((1.0 - material.subsurface) * diffuse_weight
            + material.subsurface * subsurface_weight * 0.5);
    let diffuse = [
        material.base_color[0] * diffuse_scale,
        material.base_color[1] * diffuse_scale,
        material.base_color[2] * diffuse_scale,
    ];
    let sheen_tint = [
        1.0 - 0.5 * (1.0 - material.base_color[0]),
        1.0 - 0.5 * (1.0 - material.base_color[1]),
        1.0 - 0.5 * (1.0 - material.base_color[2]),
    ];
    let sheen_scale = material.sheen * (1.0 - vdoth).powi(5) / std::f32::consts::PI;
    let sheen = [
        sheen_tint[0] * sheen_scale,
        sheen_tint[1] * sheen_scale,
        sheen_tint[2] * sheen_scale,
    ];
    let d = ggx_distribution(material.roughness, ndoth);
    let k = material.roughness.max(1e-3) * 0.5;
    let g = (smith_g1(ndotl.max(1e-6), k) * smith_g1(ndotv.max(1e-6), k)).min(1.0);
    let f = schlick(vdoth, f0_color(material));
    let spec_scale = (d * g) / (4.0 * ndotv.max(1e-6) * ndotl.max(1e-6));
    let coat_roughness = 0.25;
    let coat_d = ggx_distribution(coat_roughness, ndoth);
    let coat_f = 0.04 + 0.96 * (1.0 - vdoth).powi(5);
    let coat_scale =
        material.clearcoat * 0.25 * coat_d * g / (4.0 * ndotv.max(1e-6) * ndotl.max(1e-6));
    [
        diffuse[0] + sheen[0] + f[0] * spec_scale + coat_f * coat_scale,
        diffuse[1] + sheen[1] + f[1] * spec_scale + coat_f * coat_scale,
        diffuse[2] + sheen[2] + f[2] * spec_scale + coat_f * coat_scale,
    ]
}

fn ashikhmin_shirley(material: &Material, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let h = half_vector(v, l);
    let ndotl = dot3(n, l).max(1e-6);
    let ndotv = dot3(n, v).max(1e-6);
    let ndoth = saturate(dot3(n, h));
    let vdoth = dot3(v, h).max(1e-6);
    let f = schlick(vdoth, f0_color(material));
    let diffuse_scale = (28.0 / (23.0 * std::f32::consts::PI))
        * (1.0 - 0.04)
        * (1.0 - material.metallic)
        * (1.0 - (1.0 - ndotl * 0.5).powi(5))
        * (1.0 - (1.0 - ndotv * 0.5).powi(5));
    let diffuse = [
        material.base_color[0] * diffuse_scale,
        material.base_color[1] * diffuse_scale,
        material.base_color[2] * diffuse_scale,
    ];
    let alpha2 = (material.roughness * material.roughness).max(1e-4);
    let exponent = ((1.0 / alpha2) * (1.0 + material.anisotropy.abs())).clamp(1.0, 2048.0);
    let spec_scale = (exponent + 1.0) / (8.0 * std::f32::consts::PI) * ndoth.powf(exponent)
        / (vdoth * ndotl.max(ndotv));
    [
        diffuse[0] + f[0] * spec_scale,
        diffuse[1] + f[1] * spec_scale,
        diffuse[2] + f[2] * spec_scale,
    ]
}

fn ward(material: &Material, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let h = half_vector(v, l);
    let ndotl = dot3(n, l).max(1e-4);
    let ndotv = dot3(n, v).max(1e-4);
    let ndoth = dot3(n, h).max(1e-4);
    let alpha2 =
        (material.roughness * material.roughness * (1.0 - 0.9 * material.anisotropy.abs()))
            .max(1e-4);
    let tan2 = (1.0 - ndoth * ndoth) / (ndoth * ndoth);
    let f = schlick(saturate(dot3(v, h)), f0_color(material));
    let spec_scale =
        (-tan2 / alpha2).exp() / (4.0 * std::f32::consts::PI * alpha2 * (ndotl * ndotv).sqrt());
    let diffuse = diffuse_lambert(material);
    [
        diffuse[0] * (1.0 - f[0]) + f[0] * spec_scale,
        diffuse[1] * (1.0 - f[1]) + f[1] * spec_scale,
        diffuse[2] * (1.0 - f[2]) + f[2] * spec_scale,
    ]
}

fn toon(material: &Material, n: [f32; 3], _v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let ndotl = saturate(dot3(n, l));
    let quantized = (ndotl * 3.0 + 0.5).floor() / 3.0;
    let level = 0.3 + 0.7 * quantized.clamp(0.0, 1.0);
    let diffuse = diffuse_lambert(material);
    [diffuse[0] * level, diffuse[1] * level, diffuse[2] * level]
}

fn minnaert(material: &Material, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let ndotl = saturate(dot3(n, l));
    let ndotv = saturate(dot3(n, v));
    let darkening = material.anisotropy.abs().clamp(0.0, 1.0);
    let factor = ndotl.powf(darkening) * ndotv.powf(1.0 - darkening);
    let diffuse = diffuse_lambert(material);
    [
        diffuse[0] * factor,
        diffuse[1] * factor,
        diffuse[2] * factor,
    ]
}

/// Evaluate a BRDF value without the NdotL cosine term; the caller applies it.
pub fn evaluate_brdf(
    model: BrdfModel,
    material: &Material,
    normal: [f32; 3],
    view: [f32; 3],
    light: [f32; 3],
) -> [f32; 3] {
    let n = normalize_or(normal, [0.0, 1.0, 0.0]);
    let v = normalize_or(view, [0.0, 1.0, 0.0]);
    let l = normalize_or(light, [0.0, 1.0, 0.0]);
    let mut value = match model.effective() {
        BrdfModel::Lambert => diffuse_lambert(material),
        BrdfModel::Phong => phong(material, n, v, l),
        BrdfModel::OrenNayar => oren_nayar(material, n, v, l),
        BrdfModel::CookTorranceGgx => cook_torrance(material, n, v, l, false),
        BrdfModel::CookTorranceBeckmann => cook_torrance(material, n, v, l, true),
        BrdfModel::DisneyPrincipled => disney_principled(material, n, v, l),
        BrdfModel::AshikhminShirley => ashikhmin_shirley(material, n, v, l),
        BrdfModel::Ward => ward(material, n, v, l),
        BrdfModel::Toon => toon(material, n, v, l),
        BrdfModel::Minnaert => minnaert(material, n, v, l),
        BrdfModel::BlinnPhong | BrdfModel::Subsurface | BrdfModel::Hair => {
            unreachable!("effective() resolves these")
        }
    };
    for component in &mut value {
        if !component.is_finite() || *component < 0.0 {
            *component = 0.0;
        }
    }
    value
}

fn add3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale3(value: [f32; 3], scale: f32) -> [f32; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn invalid(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;
