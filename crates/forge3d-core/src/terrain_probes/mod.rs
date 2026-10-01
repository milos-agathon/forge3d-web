//! W09 native analytical SH/reflection bakers ported from bf8db93.
//! Source coordinates and cubemaps are z-up; the web boundary adapts y-up coordinates.
pub mod baker;
pub mod heightfield_baker;
pub mod reflection_baker;
pub mod types;
pub use baker::*;
pub use heightfield_baker::*;
pub use reflection_baker::*;
pub use types::*;

#[derive(Clone, Debug)]
pub struct HdrImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}
