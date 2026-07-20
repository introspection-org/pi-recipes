use pi_recipe_check::{check_recipe_files, CheckProfile, RecipeFiles};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

fn parse_profile(profile: &str) -> PyResult<CheckProfile> {
    match profile {
        "local" => Ok(CheckProfile::Local),
        "ci" => Ok(CheckProfile::Ci),
        "publish" => Ok(CheckProfile::Publish),
        _ => Err(PyValueError::new_err(format!(
            "unknown check profile {profile:?}; expected local, ci, or publish"
        ))),
    }
}

/// Validate a serialized in-memory recipe snapshot and return a serialized report.
#[pyfunction]
#[pyo3(signature = (snapshot_json, profile = "local"))]
fn check_recipe_files_json(py: Python<'_>, snapshot_json: &str, profile: &str) -> PyResult<String> {
    let snapshot: RecipeFiles = serde_json::from_str(snapshot_json)
        .map_err(|err| PyValueError::new_err(format!("invalid recipe snapshot: {err}")))?;
    let profile = parse_profile(profile)?;
    let report = py.detach(move || check_recipe_files(&snapshot, profile));
    serde_json::to_string(&report)
        .map_err(|err| PyValueError::new_err(format!("failed to encode check report: {err}")))
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add("__version__", env!("CARGO_PKG_VERSION"))?;
    module.add_function(wrap_pyfunction!(check_recipe_files_json, module)?)?;
    Ok(())
}
