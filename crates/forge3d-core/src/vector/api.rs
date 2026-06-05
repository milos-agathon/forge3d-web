// src/vector/api.rs
// Vector API, validation, and GPU bridges
// Exists to expose safe typed data contracts and orchestrate mesh workflows
// RELEVANT FILES: src/vector/extrusion.rs, src/vector/gpu_extrusion.rs, python/forge3d/__init__.py, docs/api/polygon_extrusion.md
//! H1: Public API definition (vectors)
//! Freeze Python surface for vectors/graphs with CRS validation.

mod core;
mod extrusion;

pub use core::{
    CrsType, GraphDef, PointDef, PolygonDef, PolylineDef, VectorApi, VectorId, VectorStyle,
};

#[cfg(test)]
mod tests;
