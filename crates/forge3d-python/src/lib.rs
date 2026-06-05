use pyo3::prelude::*;

pub mod gpu;

#[pymodule]
fn _forge3d(_py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__workspace_split_phase__", 3)?;
    Ok(())
}
