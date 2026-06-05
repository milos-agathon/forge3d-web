use pyo3::prelude::*;

#[pymodule]
fn _forge3d(_py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__workspace_split_phase__", 2)?;
    Ok(())
}
