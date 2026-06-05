#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn install_panic_hook() {
    console_error_panic_hook::set_once();
}
