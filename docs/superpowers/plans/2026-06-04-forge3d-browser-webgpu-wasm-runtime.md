# Forge3D Browser WebGPU/WASM Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Forge3D into platform-separated Rust crates and add a real browser WebGPU/WASM runtime with a stable JavaScript/TypeScript API, while preserving the current Python package contract.

**Architecture:** `forge3d-core` becomes the PyO3-free rendering/data/model layer. `forge3d-python` owns maturin/PyO3/NumPy and blocking Python convenience APIs. `forge3d-web` owns wasm-bindgen, canvas-backed WebGPU presentation, browser IO, TypeScript declarations, npm packaging, and Playwright browser tests. `forge3d-native-viewer` owns `winit`, stdin, TCP IPC, and native window/event-loop behavior.

**Tech Stack:** Rust 2021, `wgpu = 0.19` initially, `wasm-bindgen`, `web-sys`, `js-sys`, `serde`, `serde-wasm-bindgen`, TypeScript, Vite examples, Playwright, maturin/PyO3 for Python only.

---

## 1. Executive Diagnosis

Forge3D is currently a Python-first native `wgpu` renderer with reusable Rust internals, not an almost-ready browser runtime. The local baseline confirms this:

```powershell
cargo check --target wasm32-unknown-unknown --no-default-features
```

fails in `pyo3-ffi` with missing wasm target libc symbols such as `libc::wchar_t`, `libc::size_t`, `libc::uintptr_t`, `libc::intptr_t`, and `libc::ssize_t`. This happens even with `--no-default-features` because root `Cargo.toml` has unconditional `pyo3` and `numpy` dependencies.

The concrete blockers in the current tree are:

- `Cargo.toml` is a single package named `forge3d`; it unconditionally depends on `pyo3`, `numpy`, `winit`, `pollster`, `reqwest`, `las`, and native/file-oriented loaders.
- `src/lib.rs` still exposes all modules from one crate and gates the PyO3 module entry point with `extension-module`, but that does not stop the dependencies from compiling.
- PyO3 code is not isolated to `src/py_module`, `src/py_functions`, and `src/py_types`; `rg "#\\[pyclass|#\\[pymethods|#\\[pyfunction|pyo3|numpy::|PyResult"` shows Python-facing code across `src/camera`, `src/geometry`, `src/io`, `src/import`, `src/terrain`, `src/scene`, `src/vector`, `src/animation`, `src/labels`, and others.
- `src/core/gpu.rs` owns a global `OnceCell<GpuContext>` and uses `pollster::block_on`, which is incompatible with browser async initialization and runtime-owned device/surface state.
- `src/scene/render_paths/rgba.rs` renders through `crate::core::gpu::ctx()` and returns a NumPy array. Browser rendering must present to a canvas and make readback optional and async.
- `src/viewer/event_loop/runner.rs` creates native `winit` windows, starts stdin handling, uses `pollster::block_on(Viewer::new(...))`, and optionally starts TCP IPC through `src/viewer/ipc/server.rs`.
- File-oriented paths appear in `src/terrain/cog/range_reader.rs`, `src/pointcloud/copc.rs`, `src/pointcloud/ept.rs`, `src/tiles3d/renderer.rs`, `src/viewer/terrain/scene/terrain_load.rs`, Python bundle/MapScene code, and many offline render paths.

The first web milestone must therefore be a product-layer split and not a superficial `wasm-bindgen` wrapper over the existing root crate.

## 2. Target Architecture

Required crates:

- `forge3d-core`: pure Rust model, validation, renderer internals, GPU resource builders, data contracts, scene schema, IO traits, and canvas-independent render commands. No PyO3, NumPy, wasm-bindgen, web-sys, winit, stdin, TCP, env-var public configuration, global GPU singleton, or blocking async calls in browser-usable paths.
- `forge3d-python`: PyO3/maturin extension crate. It preserves `import forge3d` and `forge3d._forge3d`, converts NumPy arrays and Python paths into core data structures, and owns blocking Python convenience APIs.
- `forge3d-web`: wasm-bindgen crate and npm package source. It receives `HtmlCanvasElement`, creates/configures browser WebGPU surface state asynchronously, exposes `Forge3DRuntime`, translates JS-native data into core buffers, and owns browser fetch/File/Blob/ImageBitmap adapters.
- `forge3d-native-viewer`: desktop viewer crate. It owns `winit`, native event loops, native input, stdin command reader, TCP IPC, and native snapshot plumbing. It depends on `forge3d-core`, never the reverse.

Initial `wgpu` sequencing:

- Keep `wgpu = 0.19` during the split and MVP. This keeps the dependency graph and shader behavior stable while proving crate boundaries, wasm build, canvas clear, terrain upload, TypeScript packaging, and browser tests.
- Add a separate `wgpu-modernization` phase after browser CI exists. The upgrade is then measured by the Playwright pixel tests, Rust shader audit, and Python/native compatibility checks.

## 3. Workspace And Crate Layout

Target tree:

```text
Cargo.toml
Cargo.lock
pyproject.toml
python/forge3d/
crates/
  forge3d-core/
    Cargo.toml
    src/
      lib.rs
      error.rs
      gpu/
        mod.rs
        runtime.rs
        surface.rs
      io/
        mod.rs
        source.rs
      scene_schema/
        mod.rs
        v1.rs
      render/
      terrain/
      mesh/
      pointcloud/
      tiles3d/
      vector/
      shaders/
  forge3d-python/
    Cargo.toml
    src/
      lib.rs
      py_module/
      py_functions/
      py_types/
      wrappers/
  forge3d-web/
    Cargo.toml
    package.json
    tsconfig.json
    vite.config.ts
    scripts/
      prepare-dist.mjs
    src/
      lib.rs
      runtime.rs
      error.rs
      inputs.rs
      io.rs
    src-ts/
      index.ts
    types/
      index.d.ts
    examples/vite/
    tests/playwright/
  forge3d-native-viewer/
    Cargo.toml
    src/
      lib.rs
      main.rs
      viewer/
```

Root workspace `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = [
    "crates/forge3d-core",
    "crates/forge3d-python",
    "crates/forge3d-web",
    "crates/forge3d-native-viewer",
]

[workspace.package]
version = "1.26.0"
edition = "2021"
license = "Apache-2.0 OR MIT"
repository = "https://github.com/milos-agathon/forge3d"
homepage = "https://forge3d.dev"
documentation = "https://milos-agathon.github.io/forge3d/"

[workspace.dependencies]
anyhow = "1"
async-trait = "0.1"
bytemuck = { version = "1", features = ["derive"] }
glam = "0.24"
image = { version = "0.25", default-features = false, features = ["png"] }
js-sys = "0.3"
log = "0.4"
numpy = "0.21"
once_cell = "1"
pollster = "0.3"
pyo3 = { version = "0.21.2", features = ["abi3-py310", "macros", "multiple-pymethods"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde-wasm-bindgen = "0.6"
thiserror = "1"
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
web-sys = "0.3"
wgpu = "0.19"
winit = "0.29"
```

`crates/forge3d-core/Cargo.toml`:

```toml
[package]
name = "forge3d-core"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[lib]
name = "forge3d_core"
crate-type = ["lib"]

[features]
default = []
gpu = ["dep:wgpu", "dep:bytemuck"]
webgpu = ["gpu"]
native-io = ["dep:image", "dep:tiff"]
copc = ["native-io", "dep:las"]
copc_laz = ["copc", "dep:laz"]
gltf = ["dep:gltf"]
images = ["dep:image"]
enable-gpu-instancing = []

[dependencies]
anyhow.workspace = true
async-trait.workspace = true
bytemuck = { workspace = true, optional = true }
glam.workspace = true
log.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
wgpu = { workspace = true, optional = true }
image = { workspace = true, optional = true }
tiff = { version = "0.9", optional = true }
gltf = { version = "1.3", features = ["import"], optional = true }
las = { version = "0.8", features = ["laz"], optional = true }
laz = { version = "0.9", optional = true }

[dev-dependencies]
pollster.workspace = true
```

`forge3d-core` banned dependencies:

- `pyo3`, `numpy`, `wasm-bindgen`, `web-sys`, `js-sys`, `winit`, `tokio` runtime ownership, `reqwest`, direct `std::net`, direct stdin, env-var public configuration, and direct filesystem public APIs in default/web features.

`crates/forge3d-python/Cargo.toml`:

```toml
[package]
name = "forge3d-python"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[lib]
name = "_forge3d"
crate-type = ["cdylib"]

[features]
default = ["extension-module"]
extension-module = ["pyo3/extension-module"]
async_readback = []
weighted-oit = []
enable-tbn = ["forge3d-core/enable-gpu-instancing"]
enable-gpu-instancing = ["forge3d-core/enable-gpu-instancing"]
copc_laz = ["forge3d-core/copc_laz"]

[dependencies]
forge3d-core = { path = "../forge3d-core", features = ["gpu", "native-io", "images"] }
anyhow.workspace = true
bytemuck.workspace = true
glam.workspace = true
numpy.workspace = true
pollster.workspace = true
pyo3.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
wgpu.workspace = true
```

`crates/forge3d-web/Cargo.toml`:

```toml
[package]
name = "forge3d-web"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[lib]
name = "forge3d_web"
crate-type = ["cdylib", "rlib"]

[features]
default = ["console_error_panic_hook"]

[dependencies]
forge3d-core = { path = "../forge3d-core", features = ["webgpu"] }
bytemuck.workspace = true
glam.workspace = true
js-sys.workspace = true
serde.workspace = true
serde_json.workspace = true
serde-wasm-bindgen.workspace = true
thiserror.workspace = true
wasm-bindgen.workspace = true
wasm-bindgen-futures.workspace = true
wgpu.workspace = true
console_error_panic_hook = { version = "0.1", optional = true }
web-sys = { workspace = true, features = [
    "Blob",
    "console",
    "Document",
    "HtmlCanvasElement",
    "ImageBitmap",
    "Performance",
    "Request",
    "RequestInit",
    "RequestMode",
    "Response",
    "Window",
] }

[dev-dependencies]
wasm-bindgen-test = "0.3"
```

`crates/forge3d-native-viewer/Cargo.toml`:

```toml
[package]
name = "forge3d-native-viewer"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[[bin]]
name = "forge3d-viewer"
path = "src/main.rs"

[dependencies]
forge3d-core = { path = "../forge3d-core", features = ["gpu", "native-io", "images", "copc_laz"] }
anyhow.workspace = true
bytemuck.workspace = true
glam.workspace = true
log.workspace = true
pollster.workspace = true
serde.workspace = true
serde_json.workspace = true
wgpu.workspace = true
winit.workspace = true
```

## 4. Dependency And Feature-Gating Plan

Dependency ownership:

| Dependency | Owner | Reason |
|---|---|---|
| `pyo3`, `numpy` | `forge3d-python` only | Python extension and NumPy conversion |
| `wasm-bindgen`, `web-sys`, `js-sys`, `serde-wasm-bindgen` | `forge3d-web` only | JS/WASM boundary |
| `winit` | `forge3d-native-viewer` only | Native windows and event loop |
| `pollster` | `forge3d-python`, `forge3d-native-viewer`, core dev-tests only | Blocking native convenience; banned from browser paths |
| `wgpu` | `forge3d-core`, plus frontend crates | Core render internals and frontend surface/runtime creation |
| `reqwest` | not in core MVP | Browser fetch belongs in web; Python/native HTTP can be frontend adapters |
| `std::fs`, `std::net`, stdin | Python/native crates only | Browser-hostile runtime operations |

Per-crate banned dependencies and APIs:

| Crate | Banned dependencies/APIs |
|---|---|
| `forge3d-core` | `pyo3`, `numpy`, `wasm-bindgen`, `web-sys`, `js-sys`, `winit`, `std::net`, stdin, public `PathBuf`-only loaders, `pollster::block_on` in browser-usable modules |
| `forge3d-python` | `wasm-bindgen`, `web-sys`, `winit` event-loop ownership, browser canvas APIs |
| `forge3d-web` | `pyo3`, `numpy`, `winit`, `pollster`, `std::fs` public APIs, `std::net`, stdin, env-var public configuration |
| `forge3d-native-viewer` | `pyo3`, `numpy`, `wasm-bindgen`, `web-sys`; Python package import behavior must stay in `forge3d-python` |

Feature gates:

- `forge3d-core/default = []`: proves data contracts and non-platform code compile without optional frontends.
- `forge3d-core/gpu`: enables `wgpu` render internals.
- `forge3d-core/webgpu`: enables GPU code audited for browser use.
- `forge3d-core/native-io`: enables file decoders that take `Read + Seek` or private filesystem adapters, not public `PathBuf`-only APIs.
- `forge3d-python/extension-module`: builds the PyO3 module.
- `forge3d-web/default`: browser runtime, panic hook, no native APIs.

Non-negotiable gate:

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
```

must not compile `pyo3`, `numpy`, `winit`, native viewer modules, TCP IPC, stdin code, or direct native filesystem loaders.

## 5. Python Extraction Plan

Keep the Python package name `forge3d`. Keep `python/forge3d/_native.py` loading `forge3d._forge3d`. Move the compiled extension crate from root to `crates/forge3d-python` and keep `[tool.maturin].module-name = "forge3d._forge3d"`.

Root `pyproject.toml` after split:

```toml
[tool.maturin]
bindings = "pyo3"
python-source = "python"
module-name = "forge3d._forge3d"
manifest-path = "crates/forge3d-python/Cargo.toml"
cargo-extra-args = "--profile release-lto"
features = ["extension-module", "weighted-oit", "enable-tbn", "enable-gpu-instancing", "copc_laz"]
exclude = ["assets/**", "dist*/**", "docs/**", "logs/**", "target*/**"]
```

CI must also use the explicit manifest path:

```powershell
python -m maturin build --manifest-path crates/forge3d-python/Cargo.toml --release --out dist
```

Mechanical moves:

- Move `src/py_module/**`, `src/py_functions/**`, `src/py_types/**` to `crates/forge3d-python/src/`.
- Move PyO3 wrappers embedded in core modules into `crates/forge3d-python/src/wrappers/`.
- Convert current core structs with direct `#[pyclass]` into plain core structs plus Python wrapper structs. Examples:
  - `src/scene/Scene` becomes `forge3d_core::scene::Scene`.
  - Python wrapper becomes `forge3d_python::wrappers::scene::PyScene { inner: forge3d_core::scene::Scene }`.
  - `src/terrain/renderer/core.rs::TerrainRenderer` loses `#[pyclass]`; Python wrapper owns `TerrainRenderer`.
  - `src/animation/mod.rs` PyO3 classes split into `forge3d_core::animation::{CameraKeyframe, CameraState, CameraAnimation}` and Python wrappers.
  - `src/labels/py_bindings.rs`, `src/sdf/py.rs`, and `src/terrain/cog/py_bindings.rs` move to Python crate.

Conversion rules:

- NumPy `PyReadonlyArray2<f32>` terrain heightmaps copy into `forge3d_core::terrain::HeightmapData { data: Vec<f32>, width, height, min_height, max_height }`.
- NumPy mesh arrays copy into `forge3d_core::mesh::MeshData { positions, normals, uvs, indices }` after shape/dtype validation in Python.
- NumPy point cloud arrays copy into `forge3d_core::pointcloud::PointBuffer`.
- Core returns `Vec<u8>`, `Vec<f32>`, frame metadata, and diagnostics. Python wrappers convert those into NumPy arrays or Python dicts.
- Python wrappers map `Forge3dError` into `PyValueError`, `PyRuntimeError`, `PyMemoryError`, or `PyOSError` based on error code.

Compatibility shims:

- Preserve `python/forge3d/__init__.py` exports.
- Preserve `forge3d.Scene.render_rgba()` as a Python-only blocking convenience API.
- Preserve `forge3d.Renderer`, `TerrainRenderer`, `PointBuffer`, `Session`, and current package-level re-exports.
- Keep existing contract tests in `tests/test_api_contracts.py`, then add tests asserting `_forge3d` imports from the new `forge3d-python` crate.

Proof PyO3 is absent from wasm core:

```powershell
cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features | rg "pyo3|numpy|winit|pollster"
```

Expected: no matches.

## 6. Core Runtime/GPU Redesign

Replace `src/core/gpu.rs` global singleton with explicit runtime-owned GPU state. Core should define portable types; frontend crates decide how to initialize them.

Ownership model:

- `GpuRuntime` owns `wgpu::Instance`.
- `GpuContext` owns `Arc<wgpu::Adapter>`, `Arc<wgpu::Device>`, and `Arc<wgpu::Queue>`.
- `SurfaceState` owns `wgpu::Surface<'static>` and `wgpu::SurfaceConfiguration`.
- `Renderer` owns reusable pipelines, render targets, resource caches, and a `GpuContext`.
- `Scene` owns scene data and GPU resources for terrain/mesh/point layers.
- Frontends own event loops, canvases/windows, and blocking/async entry points.

Async GPU skeleton in `crates/forge3d-core/src/gpu/runtime.rs`:

```rust
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct GpuRuntimeOptions {
    pub power_preference: wgpu::PowerPreference,
    pub required_features: wgpu::Features,
    pub required_limits: wgpu::Limits,
    pub label: Option<String>,
}

pub struct GpuRuntime {
    pub instance: Arc<wgpu::Instance>,
}

#[derive(Clone)]
pub struct GpuContext {
    pub adapter: Arc<wgpu::Adapter>,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
}

pub struct SurfaceState {
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
}

impl GpuRuntime {
    pub fn new(instance: wgpu::Instance) -> Self {
        Self { instance: Arc::new(instance) }
    }

    pub async fn request_context(
        &self,
        compatible_surface: Option<&wgpu::Surface<'_>>,
        options: &GpuRuntimeOptions,
    ) -> Result<GpuContext, crate::error::Forge3dError> {
        let adapter = self.instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: options.power_preference,
            compatible_surface,
            force_fallback_adapter: false,
        }).await.ok_or(crate::error::Forge3dError::AdapterUnavailable)?;

        let (device, queue) = adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: options.label.as_deref(),
                required_features: options.required_features,
                required_limits: options.required_limits.clone(),
            },
            None,
        ).await.map_err(|error| crate::error::Forge3dError::DeviceRequest {
            message: error.to_string(),
        })?;

        Ok(GpuContext {
            adapter: Arc::new(adapter),
            device: Arc::new(device),
            queue: Arc::new(queue),
        })
    }
}
```

Native blocking support is isolated:

```rust
pub fn request_context_blocking(
    runtime: &GpuRuntime,
    options: &GpuRuntimeOptions,
) -> Result<GpuContext, Forge3dError> {
    pollster::block_on(runtime.request_context(None, options))
}
```

This function lives in `forge3d-python` or `forge3d-native-viewer`, not `forge3d-core` browser modules.

Removal plan:

- Replace `crate::core::gpu::ctx()` calls with injected `&GpuContext` or renderer-owned context fields.
- Replace `Scene::new(width, height, ...)` with `Scene::new(context: GpuContext, descriptor: SceneDescriptor)`.
- Replace readback functions that call `pollster::block_on` with async versions in core and blocking wrappers in Python/native only.
- Keep `align_copy_bpr` as a pure helper in core.

Device loss:

- Core returns `Forge3dError::SurfaceLost`, `SurfaceOutdated`, or `DeviceLost`.
- Web runtime catches surface errors during `render()` and reconfigures on lost/outdated.
- Python/native blocking wrappers can recreate a runtime only when the caller asks; no hidden global recreation.

## 7. Browser WebGPU/WASM Runtime Design

`forge3d-web` creates a browser surface from `HtmlCanvasElement` and exposes only async creation.

Wasm-bindgen skeleton in `crates/forge3d-web/src/runtime.rs`:

```rust
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen]
pub struct Forge3DRuntime {
    canvas: HtmlCanvasElement,
    instance: wgpu::Instance,
    surface: wgpu::Surface<'static>,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: forge3d_core::render::Renderer,
}

#[wasm_bindgen]
impl Forge3DRuntime {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(canvas: HtmlCanvasElement, options: JsValue) -> Result<Forge3DRuntime, JsValue> {
        console_error_panic_hook::set_once();

        let options: Forge3DRuntimeOptions =
            serde_wasm_bindgen::from_value(options).map_err(crate::error::to_js_error)?;

        let width = options.width.unwrap_or(canvas.client_width().max(1) as u32);
        let height = options.height.unwrap_or(canvas.client_height().max(1) as u32);
        canvas.set_width(width);
        canvas.set_height(height);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|error| crate::error::js_error("SURFACE_CREATE_FAILED", error.to_string()))?;

        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: options.power_preference.into(),
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }).await.ok_or_else(|| crate::error::js_error("WEBGPU_ADAPTER_UNAVAILABLE", "No WebGPU adapter is available"))?;

        let adapter_limits = adapter.limits();
        let required_limits = wgpu::Limits::downlevel_defaults().using_resolution(adapter_limits);
        let required_features = wgpu::Features::empty();

        let (device, queue) = adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("forge3d-web-device"),
                required_features,
                required_limits,
            },
            None,
        ).await.map_err(|error| crate::error::js_error("DEVICE_REQUEST_FAILED", error.to_string()))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter()
            .copied()
            .find(|format| format.is_srgb())
            .unwrap_or(caps.formats[0]);
        let present_mode = caps.present_modes.iter()
            .copied()
            .find(|mode| *mode == wgpu::PresentMode::Fifo)
            .unwrap_or(caps.present_modes[0]);
        let alpha_mode = caps.alpha_modes.iter()
            .copied()
            .find(|mode| *mode == wgpu::CompositeAlphaMode::Premultiplied)
            .unwrap_or(caps.alpha_modes[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            format,
            width,
            height,
            present_mode,
            alpha_mode,
            view_formats: vec![format],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let renderer = forge3d_core::render::Renderer::new(
            forge3d_core::gpu::GpuContext::from_parts(&adapter, &device, &queue),
            format,
            width,
            height,
        ).map_err(crate::error::to_js_error)?;

        Ok(Self { canvas, instance, surface, adapter, device, queue, config, renderer })
    }

    pub fn resize(&mut self, width: u32, height: u32, device_pixel_ratio: f64) -> Result<(), JsValue> {
        let pixel_width = ((width as f64) * device_pixel_ratio).round().max(1.0) as u32;
        let pixel_height = ((height as f64) * device_pixel_ratio).round().max(1.0) as u32;
        self.canvas.set_width(pixel_width);
        self.canvas.set_height(pixel_height);
        self.config.width = pixel_width;
        self.config.height = pixel_height;
        self.surface.configure(&self.device, &self.config);
        self.renderer.resize(pixel_width, pixel_height).map_err(crate::error::to_js_error)
    }

    pub fn render(&mut self, time: f64) -> Result<(), JsValue> {
        let frame = self.surface.get_current_texture()
            .map_err(crate::error::map_surface_error)?;
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.renderer.render_to_view(&self.device, &self.queue, &view, time as f32)
            .map_err(crate::error::to_js_error)?;
        frame.present();
        Ok(())
    }
}
```

Browser runtime rules:

- Creation is always async.
- `resize()` receives CSS pixel size and `devicePixelRatio`; it sets canvas backing size and reconfigures the surface.
- Required features are empty for MVP. Optional features such as `FLOAT32_FILTERABLE` are detected and exposed through diagnostics.
- Surface usage includes `COPY_SRC` for screenshots.
- `render()` presents to the canvas and never returns pixel data.
- `screenshot()` is async and copies the current or next frame to a PNG `Blob`.

## 8. Stable JavaScript/TypeScript API

Type definitions in `crates/forge3d-web/types/index.d.ts`:

```ts
export type Forge3DErrorCode =
  | "WEBGPU_UNAVAILABLE"
  | "WEBGPU_ADAPTER_UNAVAILABLE"
  | "DEVICE_REQUEST_FAILED"
  | "SURFACE_CREATE_FAILED"
  | "SURFACE_LOST"
  | "SURFACE_OUTDATED"
  | "OUT_OF_MEMORY"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "REQUEST_CANCELLED"
  | "SHADER_COMPILATION_FAILED"
  | "RUNTIME_DISPOSED";

export class Forge3DError extends Error {
  readonly code: Forge3DErrorCode;
  readonly details?: unknown;
}

export interface Forge3DRuntimeOptions {
  powerPreference?: "low-power" | "high-performance";
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  alphaMode?: "opaque" | "premultiplied";
  colorSpace?: "srgb";
  diagnostics?: boolean;
}

export interface CameraOptions {
  eye: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  fovYDegrees?: number;
  near?: number;
  far?: number;
}

export interface ColorRampStop {
  value: number;
  color: [number, number, number, number];
}

export interface TerrainHeightmapInput {
  heightmap: Float32Array | Uint16Array | Int16Array | ArrayBuffer | Blob | File | ImageBitmap | string;
  width: number;
  height: number;
  bounds?: [number, number, number, number];
  minHeight?: number;
  maxHeight?: number;
  noDataValue?: number;
  colorRamp?: ColorRampStop[];
  encoding?: "f32" | "u16" | "i16" | "image-luminance" | "geotiff";
}

export interface MeshInput {
  positions: Float32Array;
  indices?: Uint16Array | Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array | Uint8Array;
  transform?: number[];
}

export interface PointCloudInput {
  positions: Float32Array;
  colors?: Uint8Array | Float32Array;
  intensities?: Uint16Array | Float32Array;
  pointSize?: number;
  bounds?: [number, number, number, number, number, number];
}

export interface RasterOverlayInput {
  image: ImageBitmap | Blob | File | ArrayBuffer | Uint8Array | string;
  bounds: [number, number, number, number];
  opacity?: number;
}

export interface VectorLayerInput {
  features: GeoJSON.FeatureCollection | GeoJSON.Feature[];
  style?: Record<string, unknown>;
}

export interface RenderOptions {
  time?: number;
  clearColor?: [number, number, number, number];
}

export interface ScreenshotOptions {
  mimeType?: "image/png";
  includeAlpha?: boolean;
}

export interface ResourceHandle {
  readonly id: number;
  readonly kind: "terrain" | "mesh" | "pointCloud" | "rasterOverlay" | "vectorLayer";
}

export class Forge3DRuntime {
  static create(canvas: HTMLCanvasElement, options?: Forge3DRuntimeOptions): Promise<Forge3DRuntime>;
  resize(width: number, height: number, devicePixelRatio?: number): void;
  setCamera(camera: CameraOptions): void;
  setTerrain(input: TerrainHeightmapInput): Promise<ResourceHandle>;
  addMesh(input: MeshInput): ResourceHandle;
  addPointCloud(input: PointCloudInput): ResourceHandle;
  addRasterOverlay(input: RasterOverlayInput): Promise<ResourceHandle>;
  addVectorLayer(input: VectorLayerInput): ResourceHandle;
  removeResource(handle: ResourceHandle): void;
  render(time?: number, options?: RenderOptions): void;
  screenshot(options?: ScreenshotOptions): Promise<Blob>;
  dispose(): void;
}
```

Example JS usage:

```ts
import { Forge3DRuntime } from "@forge3d/web";

const canvas = document.querySelector<HTMLCanvasElement>("#map")!;
const runtime = await Forge3DRuntime.create(canvas, {
  powerPreference: "high-performance",
  devicePixelRatio: window.devicePixelRatio
});

const width = 256;
const height = 256;
const heightmap = new Float32Array(width * height);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const dx = (x - width / 2) / width;
    const dy = (y - height / 2) / height;
    heightmap[y * width + x] = 1800 * Math.exp(-(dx * dx + dy * dy) * 18);
  }
}

await runtime.setTerrain({
  heightmap,
  width,
  height,
  bounds: [-123.1, 45.1, -122.8, 45.4],
  minHeight: 0,
  maxHeight: 1800,
  colorRamp: [
    { value: 0, color: [30, 82, 50, 255] },
    { value: 900, color: [150, 130, 85, 255] },
    { value: 1800, color: [245, 245, 240, 255] }
  ]
});

runtime.setCamera({
  eye: [0, 900, 1400],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovYDegrees: 45,
  near: 1,
  far: 10000
});

const resizeObserver = new ResizeObserver(([entry]) => {
  const box = entry.contentRect;
  runtime.resize(box.width, box.height, window.devicePixelRatio);
});
resizeObserver.observe(canvas);

let running = true;
function frame(time: number) {
  if (!running) return;
  runtime.render(time);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.querySelector("#screenshot")?.addEventListener("click", async () => {
  const blob = await runtime.screenshot({ mimeType: "image/png" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
});

window.addEventListener("beforeunload", () => {
  running = false;
  resizeObserver.disconnect();
  runtime.dispose();
});
```

Lifetime and memory rules:

- `Forge3DRuntime.create` allocates WebGPU resources and must be paired with `dispose()`.
- After `dispose()`, every method throws `Forge3DError` with code `RUNTIME_DISPOSED`.
- Resource handles are runtime-local numeric handles. They are invalid after `removeResource(handle)` or `dispose()`.
- Typed arrays are copied into WASM/core-owned buffers at API boundaries for MVP. The caller may mutate or release the original JS arrays after the promise/method returns.
- `ImageBitmap`, `Blob`, `File`, URL, and `ArrayBuffer` inputs are decoded/copied before GPU upload.
- `render()` never blocks for readback.
- `screenshot()` is async and may render/copy one frame before resolving.

Validation rules:

- `Forge3DRuntimeOptions`: positive integer backing size after DPR; unsupported alpha/color options throw `INVALID_INPUT`.
- `CameraOptions`: `eye`, `target`, and `up` must be finite; `eye != target`; `near > 0`; `far > near`; `fovYDegrees` in `(1, 179)`.
- `TerrainHeightmapInput`: `width >= 2`, `height >= 2`, array length equals `width * height` after decoding, heights finite after no-data replacement, `minHeight < maxHeight`, bounds length exactly four when present, color ramp values finite and sorted or normalized by the wrapper.
- `MeshInput`: positions length divisible by three, indices length divisible by three when present, normals length equals positions length when present, uvs length equals vertex count times two, colors match vertex count.
- `PointCloudInput`: positions length divisible by three, colors match point count, intensities match point count, point size finite and positive.
- `RasterOverlayInput`: bounds length exactly four, opacity in `[0, 1]`, decoded image has positive dimensions.
- `VectorLayerInput`: feature collection is valid GeoJSON object/array and unsupported geometry types return `UNSUPPORTED_FEATURE`.
- `RenderOptions`: clear color has four finite values in `[0, 1]`.
- `ScreenshotOptions`: MVP accepts `image/png` only.

Semver policy:

- Removing or renaming exported types, methods, fields, error codes, or handle kinds is a major version change.
- Adding optional fields or new error codes is minor.
- Tightening validation for previously accepted valid inputs is major unless it fixes a documented bug.
- `forge3d-web` and Python package versions should initially match the workspace version, then may diverge only after a documented release policy decision.

Generated versus authored declarations:

- Use `wasm-bindgen` generated JS as the low-level bridge.
- Hand-author `types/index.d.ts` as the stable public API and wrap generated functions in a small TypeScript facade if necessary.
- Run TypeScript API compatibility tests against `types/index.d.ts`.

## 9. Scene Schema And Data Contracts

Existing Python scene/bundle facts:

- `python/forge3d/map_scene.py` defines `MapScene`, `SceneRecipe`, `TerrainSource`, `RasterOverlay`, `VectorOverlay`, `PointCloudLayer`, `Tiles3DLayer`, `OrbitCamera`, `LightingPreset`, `OutputSpec`, and `ReproducibilityProfile`.
- `python/forge3d/bundle.py` uses `BUNDLE_VERSION = 2` and stores `manifest.json`, terrain, overlays, camera bookmarks, render presets, scene state, and assets.
- `src/bundle/manifest.rs` currently has a smaller Rust manifest with terrain metadata and camera bookmarks.

Browser schema should be a new URL-oriented schema, not a direct Python bundle clone.

Versioned scene JSON example:

```json
{
  "schema": "forge3d.scene.v1",
  "version": 1,
  "metadata": {
    "name": "Terrain MVP"
  },
  "camera": {
    "eye": [0, 1200, 1600],
    "target": [0, 0, 0],
    "up": [0, 1, 0],
    "fovYDegrees": 45,
    "near": 1,
    "far": 100000
  },
  "terrain": {
    "id": "terrain",
    "source": {
      "kind": "url",
      "url": "./dem.f32",
      "encoding": "f32",
      "width": 1024,
      "height": 1024
    },
    "bounds": [-123.1, 45.1, -122.8, 45.4],
    "minHeight": 10,
    "maxHeight": 2840,
    "colorRamp": [
      { "value": 10, "color": [34, 80, 45, 255] },
      { "value": 2840, "color": [245, 245, 240, 255] }
    ]
  },
  "layers": [
    {
      "id": "roads",
      "kind": "vector",
      "source": { "kind": "url", "url": "./roads.geojson", "encoding": "geojson" },
      "style": { "stroke": [255, 255, 255, 220], "strokeWidth": 2 }
    }
  ]
}
```

Rust deserialization skeleton:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "schema")]
pub enum SceneDocument {
    #[serde(rename = "forge3d.scene.v1")]
    V1(scene_v1::SceneV1),
}

pub mod scene_v1 {
    #[derive(Debug, Clone, serde::Deserialize)]
    pub struct SceneV1 {
        pub version: u32,
        #[serde(default)]
        pub metadata: std::collections::BTreeMap<String, serde_json::Value>,
        pub camera: Camera,
        pub terrain: Option<TerrainLayer>,
        #[serde(default)]
        pub layers: Vec<Layer>,
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    pub struct Camera {
        pub eye: [f32; 3],
        pub target: [f32; 3],
        #[serde(default = "default_up")]
        pub up: [f32; 3],
        #[serde(default = "default_fov")]
        pub fov_y_degrees: f32,
        #[serde(default = "default_near")]
        pub near: f32,
        #[serde(default = "default_far")]
        pub far: f32,
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[serde(tag = "kind")]
    pub enum Source {
        #[serde(rename = "url")]
        Url { url: String, encoding: String, width: Option<u32>, height: Option<u32> },
        #[serde(rename = "inline-bytes")]
        InlineBytes { media_type: String, base64: String },
        #[serde(rename = "binary-ref")]
        BinaryRef { id: String, byte_offset: Option<u64>, byte_length: Option<u64> },
    }
}
```

Migration policy:

- `forge3d.scene.v1` is the first browser schema. It accepts URL, inline bytes for small examples, and external binary references.
- Add `migrations/v1_to_v2.rs` when schema v2 exists.
- Do not load Python `.forge3d` bundles directly in MVP; add a converter from `MapScene`/bundle to `forge3d.scene.v1` as a separate bridge after terrain MVP.

TypeScript scene types:

```ts
export interface Forge3DSceneV1 {
  schema: "forge3d.scene.v1";
  version: 1;
  metadata?: Record<string, unknown>;
  camera: CameraOptions;
  terrain?: SceneTerrainLayer;
  layers?: SceneLayer[];
}

export type SceneSource =
  | { kind: "url"; url: string; encoding: string; width?: number; height?: number }
  | { kind: "inline-bytes"; mediaType: string; base64: string }
  | { kind: "binary-ref"; id: string; byteOffset?: number; byteLength?: number };

export interface SceneTerrainLayer {
  id: string;
  source: SceneSource;
  bounds?: [number, number, number, number];
  minHeight?: number;
  maxHeight?: number;
  colorRamp?: ColorRampStop[];
}

export type SceneLayer =
  | { id: string; kind: "mesh"; source: SceneSource; transform?: number[] }
  | { id: string; kind: "pointCloud"; source: SceneSource; pointSize?: number }
  | { id: string; kind: "raster"; source: SceneSource; bounds: [number, number, number, number]; opacity?: number }
  | { id: string; kind: "vector"; source: SceneSource; style?: Record<string, unknown> };
```

## 10. Browser-Compatible IO Architecture

Core IO traits in `crates/forge3d-core/src/io/source.rs`:

```rust
#[derive(Debug, Clone, Copy)]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}

#[derive(Debug, Clone)]
pub struct ByteChunk {
    pub offset: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ProgressEvent {
    pub loaded: u64,
    pub total: Option<u64>,
}

pub trait CancellationToken {
    fn is_cancelled(&self) -> bool;
}

#[async_trait::async_trait(?Send)]
pub trait ByteSource {
    async fn len(&self) -> Result<Option<u64>, crate::error::Forge3dError>;
    async fn read_range(
        &self,
        range: ByteRange,
        cancel: Option<&dyn CancellationToken>,
    ) -> Result<ByteChunk, crate::error::Forge3dError>;
}

#[async_trait::async_trait(?Send)]
pub trait ImageSource {
    async fn decode_rgba8(&self) -> Result<ImageData, crate::error::Forge3dError>;
}

pub struct ImageData {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
```

Platform mapping:

| Contract | Browser mapping | Python mapping | Native viewer mapping |
|---|---|---|---|
| URL bytes | `fetch` with `Range` header | `urllib`, `requests`, or Python file object adapter | `reqwest` or local file adapter |
| File/blob | `File`/`Blob.arrayBuffer()` | Python file-like object | `std::fs::File` |
| Array bytes | `ArrayBuffer`/`Uint8Array` copied into WASM | `bytes`, `bytearray`, NumPy | `Vec<u8>` |
| Image | `ImageBitmap` or fetched blob decoded in browser | Pillow/rasterio path adapters | `image` crate |
| Cancellation | `AbortSignal` translated to a web token | Python cancellation token optional | native channel/atomic flag |
| Progress | JS callback receives loaded/total | Python callback optional | native callback optional |

Core decoders must accept `&[u8]`, `Read + Seek` private adapters, or `ByteSource`; public APIs must not require `PathBuf`.

## 11. Rendering Feature Plan By Domain

| Domain | MVP | Near-term | Post-MVP | Explicitly out of scope for MVP |
|---|---|---|---|---|
| Terrain heightmaps | `Float32Array` upload, bounds, min/max, color ramp, camera, canvas render | URL/Blob/File f32/u16 inputs, ImageBitmap luminance | GeoTIFF/COG streaming through byte sources | Full Python terrain material parity |
| Meshes | Stable API and validation, may throw `UNSUPPORTED_FEATURE` until terrain MVP complete | Raw typed-array mesh rendering | glTF/3D Tiles mesh ingestion | Python OBJ/PLY path-only APIs in browser |
| Point clouds | Stable API and validation, raw typed-array point buffer after terrain | Point budget, color/intensity buffers | COPC/EPT range loading and LAZ parsing in worker | Full COPC/EPT parity in MVP |
| Raster overlays | API shape and validation | ImageBitmap overlay over terrain | COG/raster tile streaming | Rasterio/path-based browser API |
| Vector layers | GeoJSON contract and validation | CPU tessellation to line/polygon buffers | labels and Mapbox Style subset | Full style spec parity |
| COPC/EPT/LAZ | Not MVP | Metadata parsing from bytes | Range requests, decompression worker, LOD cache | Blocking file-only loaders |
| 3D Tiles | Not MVP | Parse `tileset.json` from URL | b3dm/pnts render path with byte sources | Full 3D Tiles styling/metadata parity |
| Screenshots/readback | Async PNG `Blob` screenshot | Optional async RGBA readback | HDR/readback variants | Blocking readback as primary render path |

## 12. Shader/WebGPU Compatibility Audit

Audit all WGSL under `src/shaders/**` and shaders currently embedded under `src/viewer/terrain/**`.

Checklist:

- Validate each WGSL module in Chrome/Edge through actual pipeline creation, not only Rust unit tests.
- Count bind groups per pipeline; WebGPU commonly requires staying within four bind groups unless adapter limits allow more. Existing shader comments in `src/shaders/hybrid_traversal.wgsl` already mention grouping to stay within `max_bind_groups=4`.
- Audit bind group layouts for storage textures, storage buffers, sampled textures, and samplers against adapter limits.
- Verify `Rgba16Float`, `Rgba32Float`, and `Depth32Float` usages on browser adapters.
- Gate `FLOAT32_FILTERABLE` usage; current terrain code already checks this in places such as `src/scene/core/constructor.rs`.
- Confirm storage texture format support for bloom, DOF, IBL, height AO, terrain offline accumulation, and GI paths.
- Verify sampler restrictions: filtering sampler cannot sample unfilterable float textures.
- Check buffer alignment: uniform buffer offsets, storage buffer layout, `COPY_BYTES_PER_ROW_ALIGNMENT`.
- Check readback row padding for screenshots and optional RGBA readback.
- Check dynamic offsets, multisampling, and resolve targets.
- Disable timestamp queries and native GPU diagnostics in web unless `Features::TIMESTAMP_QUERY` is supported and the browser accepts the path.
- Capture shader module creation errors and map them to `SHADER_COMPILATION_FAILED`.

Browser test order:

1. Chrome stable local: `npm run test:browser -- --project=chromium`.
2. Edge stable local: same Playwright suite with Edge channel.
3. GitHub Actions Windows Chrome/Edge lane for required MVP pixel test.
4. Firefox/Safari lanes start as capability probes and become required only when WebGPU availability is reliable for the selected CI runner.

## 13. Native Viewer Separation

Move these current modules to `crates/forge3d-native-viewer/src/viewer/`:

- `src/viewer/**`
- `src/bin/interactive_viewer.rs`
- native viewer CLI under `src/cli/interactive_viewer*`

Native-only ownership:

- `winit::event_loop`, `winit::window::WindowBuilder`
- native `Window` surface creation
- stdin reader in `src/viewer/event_loop/stdin_reader/**`
- TCP IPC in `src/viewer/ipc/server.rs`
- env-var configuration such as `FORGE3D_SKY_MODEL`, `FORGE3D_AUTO_SNAPSHOT_PATH`, and backend debug variables
- desktop snapshot file output paths

Reusable logic that can remain or move into core:

- Pure camera math.
- Terrain mesh generation.
- Typed render settings.
- CPU validation.
- GPU pipeline/resource builders that take `&Device`, `&Queue`, formats, and explicit options.

## 14. Threading/Workers Plan

MVP:

- Run WebGPU rendering on the main browser thread with a visible `HTMLCanvasElement`.
- Avoid Rust threads and `wasm-bindgen-rayon`.
- Keep heavy parsing out of the first MVP path by accepting direct typed arrays for terrain.

Near-term workers:

- Add a JS `Worker` for parsing COPC/EPT/3D Tiles/raster sources into transferable `ArrayBuffer`s.
- Keep WebGPU device/canvas ownership on the main thread unless moving to `OffscreenCanvas` is explicitly selected.
- If `OffscreenCanvas` is added, expose `Forge3DRuntime.createOffscreen(canvas, options)` as a separate API.

Shared memory:

- Do not require cross-origin isolation for MVP.
- Introduce `wasm-bindgen-rayon` only if profiling shows parsing/decompression needs Rust threads and deployment can guarantee COOP/COEP headers.

## 15. Error Handling And Diagnostics

Core error enum:

```rust
#[derive(Debug, thiserror::Error)]
pub enum Forge3dError {
    #[error("WebGPU adapter unavailable")]
    AdapterUnavailable,
    #[error("Device request failed: {message}")]
    DeviceRequest { message: String },
    #[error("Unsupported feature: {feature}")]
    UnsupportedFeature { feature: String },
    #[error("Invalid input {field}: {message}")]
    InvalidInput { field: String, message: String },
    #[error("Shader compilation failed in {label}: {message}")]
    ShaderCompilation { label: String, message: String },
    #[error("Surface lost")]
    SurfaceLost,
    #[error("Surface outdated")]
    SurfaceOutdated,
    #[error("Out of GPU memory")]
    OutOfMemory,
    #[error("IO failed: {message}")]
    Io { message: String },
    #[error("Request cancelled")]
    Cancelled,
    #[error("Runtime has been disposed")]
    RuntimeDisposed,
}
```

JS mapping:

- `Forge3dError::AdapterUnavailable` -> `Forge3DError("WEBGPU_ADAPTER_UNAVAILABLE")`
- device request -> `DEVICE_REQUEST_FAILED`
- surface lost/outdated -> `SURFACE_LOST` or `SURFACE_OUTDATED`
- invalid typed-array length/dtype -> `INVALID_INPUT`
- unsupported MVP method -> `UNSUPPORTED_FEATURE`
- IO/Range/fetch failures -> `IO_ERROR`
- cancellation -> `REQUEST_CANCELLED`
- panic hook logs to console and surfaces as a JS exception.

Python mapping:

- invalid input -> `PyValueError`
- IO -> `PyOSError`
- device/runtime/shader failures -> `PyRuntimeError`
- OOM -> `PyMemoryError`

Diagnostics:

- Web runtime exposes optional `runtime.getDiagnostics()` after MVP if needed.
- Console logging uses `web_sys::console` in web and `log`/`env_logger` in native/Python.
- No browser public API reads env vars.

## 16. Packaging/npm Release Plan

Package name:

- Preferred: `@forge3d/web`.
- Fallback if namespace is unavailable: `forge3d-web`.
- Skeleton below uses `@forge3d/web`.

`crates/forge3d-web/package.json`:

```json
{
  "name": "@forge3d/web",
  "version": "1.26.0",
  "type": "module",
  "description": "Forge3D browser WebGPU/WASM runtime",
  "license": "Apache-2.0 OR MIT",
  "files": ["dist", "types", "README.md", "LICENSE", "LICENSE-APACHE"],
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "import": "./dist/index.js"
    },
    "./wasm": "./dist/forge3d_web_bg.wasm"
  },
  "types": "./types/index.d.ts",
  "scripts": {
    "build:wasm": "wasm-pack build . --target web --out-dir pkg --out-name forge3d_web",
    "build:ts": "tsc -p tsconfig.json",
    "build": "npm run build:wasm && npm run build:ts && node scripts/prepare-dist.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test:browser": "playwright test",
    "lint": "eslint src-ts tests --ext .ts"
  },
  "devDependencies": {
    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0",
    "vite": "^5.0.0",
    "eslint": "^9.0.0",
    "wasm-pack": "^0.13.0"
  }
}
```

Bundler and asset handling:

- Publish ESM only.
- Include `.wasm` in `dist`.
- The TS facade imports the wasm-pack JS loader and exposes `Forge3DRuntime.create(...)`.
- Vite example imports from `@forge3d/web`; Vite serves `.wasm` with `application/wasm`.
- README documents non-Vite usage requiring correct `application/wasm` MIME type.

Cache headers:

- `.wasm`: `Cache-Control: public, max-age=31536000, immutable` when filename is content-hashed.
- JS/types: use normal package manager cache or content-hashed CDN URL.
- Scene/data URLs: application-specific caching with CORS and Range support where streaming is used.

Release checklist:

- `wasm-pack build crates/forge3d-web --target web`
- `npm run typecheck`
- `npm run test:browser`
- inspect packed artifact with `npm pack --dry-run`
- publish dry run to npm
- update README browser support matrix
- tag with matching workspace version

## 17. CI And Testing Plan

Required commands:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --features default -- -D warnings
cargo test -p forge3d-core
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
wasm-pack build crates/forge3d-web --target web
cd crates/forge3d-web
npm ci
npm run typecheck
npm run test:browser
python -m maturin build --manifest-path crates/forge3d-python/Cargo.toml --release --out dist
python scripts/install_compatible_wheel.py dist
pytest tests/test_install_smoke.py tests/test_api_contracts.py -v --tb=short
```

GitHub Actions web job skeleton:

```yaml
name: Web Runtime

on:
  pull_request:
  push:
    branches: [main, develop]

jobs:
  wasm-and-browser:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: crates/forge3d-web/package-lock.json
      - name: Core wasm check
        run: cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
      - name: Web wasm check
        run: cargo check -p forge3d-web --target wasm32-unknown-unknown
      - name: Install web dependencies
        working-directory: crates/forge3d-web
        run: npm ci
      - name: Build wasm package
        run: wasm-pack build crates/forge3d-web --target web
      - name: Typecheck
        working-directory: crates/forge3d-web
        run: npm run typecheck
      - name: Install Playwright browsers
        working-directory: crates/forge3d-web
        run: npx playwright install chromium
      - name: Browser render tests
        working-directory: crates/forge3d-web
        env:
          FORGE3D_WEBGPU_REQUIRED: "1"
        run: npm run test:browser
```

Playwright WebGPU launch:

```ts
import { chromium, expect, test } from "@playwright/test";

test.use({
  launchOptions: {
    args: ["--enable-unsafe-webgpu"]
  }
});

test("clears canvas through Forge3D WebGPU runtime", async ({ page }) => {
  await page.goto("/examples/test-clear.html");
  const supported = await page.evaluate(() => Boolean(navigator.gpu));
  expect(supported).toBeTruthy();
  const pixels = await page.evaluate(() => window.__forge3dReadProbe());
  expect(pixels.nonBlackPixels).toBeGreaterThan(100);
});
```

## 18. Step-By-Step Migration Phases

Progress-tracking spec: `docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md`

| Phase | Goal | Files/dirs touched | Exact changes | Tests/commands | Acceptance criteria | Risks | Rollback |
|---|---|---|---|---|---|---|---|
| 1 | Baseline audit and reproduce wasm failure (Done) | `Cargo.toml`, `pyproject.toml`, `src/lib.rs`, `src/core/gpu.rs`, `docs/superpowers/plans/*` | Completed 2026-06-04: recorded current failure, `cargo tree`, and `rg` inventories for PyO3, NumPy, winit, pollster, fs, TCP, stdin in `docs/superpowers/audits/2026-06-04-forge3d-browser-webgpu-wasm-phase1-baseline-audit.md` | `cargo check --target wasm32-unknown-unknown --no-default-features`; `rg "#\\[pyclass|pyo3|numpy"` | Failure is documented as `pyo3-ffi`; no code moved yet | Audit may miss generated files | Documentation-only rollback removes audit note |
| 2 | Workspace split | `Cargo.toml`, `crates/forge3d-core`, `crates/forge3d-python`, `crates/forge3d-web`, `crates/forge3d-native-viewer` | Convert root to workspace; create crate manifests; copy current `src` into `crates/forge3d-core/src` as temporary staging; create Python/web/native crate roots | `cargo metadata --no-deps`; `cargo check -p forge3d-core --no-default-features` | Workspace resolves and package names are stable | Large move can disrupt paths | Revert workspace commit only |
| 3 | PyO3/NumPy extraction | `crates/forge3d-python/src`, `crates/forge3d-core/src`, `pyproject.toml` | Move PyO3 modules to Python crate; remove PyO3 attributes/imports from core; add wrapper types around core structs | `cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features | rg "pyo3|numpy"` | No matches for PyO3/NumPy in core tree | Many embedded `PyResult` uses | Revert extraction commit; keep workspace shell |
| 4 | Core wasm check passing | `crates/forge3d-core/src/lib.rs`, feature gates | Gate native IO/viewer/offline modules; keep pure data/model modules available | `cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features` | Command passes and excludes PyO3, NumPy, winit, TCP, stdin | Some modules compile on wasm but are unusable | Re-enable module behind native feature |
| 5 | GPU context ownership redesign | `crates/forge3d-core/src/gpu`, `scene`, `terrain`, `renderer` | Add `GpuRuntime`, `GpuContext`, `SurfaceState`; replace `core::gpu::ctx()` in browser-relevant render paths with injected context | `cargo test -p forge3d-core gpu`; Python scene tests | No global GPU singleton in web/core render paths | Refactor touches many call sites | Keep compatibility helper in Python crate only |
| 6 | Browser crate creation | `crates/forge3d-web/src`, `package.json`, `types/index.d.ts` | Add wasm-bindgen crate, error mapping, TS facade, npm scripts | `cargo check -p forge3d-web --target wasm32-unknown-unknown`; `npm run typecheck` | Web crate compiles to wasm | wgpu 0.19 API mismatch | Adjust browser surface code within web crate |
| 7 | Minimal canvas clear | `forge3d-web/src/runtime.rs`, `forge3d-core/src/render` | Implement async create, resize, clear-color render to canvas | `wasm-pack build`; `npm run test:browser` | Playwright detects nonblank colored canvas | CI WebGPU availability | Run required lane on Windows; add clear browser capability probe |
| 8 | Terrain heightmap upload and render | `forge3d-core/src/terrain`, `forge3d-web/src/inputs.rs`, `types/index.d.ts` | Add `TerrainHeightmapInput` validation, typed-array copy, R32Float upload, terrain mesh draw | Browser pixel test with synthetic hill | Terrain renders with height/color variation | Float texture filter support | Use nearest sampling fallback when `FLOAT32_FILTERABLE` absent |
| 9 | Camera and resize API | `forge3d-core/src/camera`, `forge3d-web/src/runtime.rs` | Add `setCamera`, DPR-aware resize, surface reconfigure, projection updates | Playwright resize test; TS API test | Canvas dimensions match DPR and camera changes pixels | CSS/backing size confusion | Keep API explicit: CSS width/height plus DPR |
| 10 | Screenshot/readback | `forge3d-core/src/readback`, `forge3d-web/src/runtime.rs` | Add async padded readback and PNG blob creation | Browser screenshot test checks Blob type and nonzero size | `await runtime.screenshot()` returns PNG Blob | PNG encoding size/perf | Use browser `ImageData`/canvas encoding if Rust PNG path is too heavy |
| 11 | JS/TS API stabilization | `types/index.d.ts`, TS facade, docs examples | Freeze names, handles, errors, lifetime rules, typed-array validation | `npm run typecheck`; API snapshot test | Public API matches this plan | wasm-bindgen generated names leak | Keep stable facade separate from generated JS |
| 12 | Browser IO abstraction | `forge3d-core/src/io`, `forge3d-web/src/io.rs` | Add `ByteSource`, browser URL/File/Blob/ArrayBuffer adapters, progress/cancel mapping | Unit tests with fake source; browser fetch test | URL/Blob/ArrayBuffer terrain inputs work | CORS/Range failures | Clear error codes and docs |
| 13 | Packaging | `crates/forge3d-web/package.json`, `README.md`, `examples/vite` | Produce dist, wasm asset, types, Vite example, npm dry run | `npm pack --dry-run`; Vite example build | Package contains JS, wasm, d.ts, README | wasm path breakage in bundlers | Add import/asset tests |
| 14 | Browser CI | `.github/workflows/web.yml`, Playwright tests | Add required wasm/web/test jobs | GitHub Actions web job | Required commands pass in CI | Hosted GPU variability | Use Windows Chrome lane and capability diagnostics |
| 15 | Native/Python compatibility restoration | `crates/forge3d-python`, `crates/forge3d-native-viewer`, Python tests | Reconnect Python wrappers, maturin build, native viewer binary | maturin build; pytest smoke/API; native cargo check | Existing Python import/API contracts pass | Wrapper behavior drift | Contract tests catch drift; revert wrapper changes by module |
| 16 | MVP release hardening | docs, changelog, package metadata, examples | Browser README, support matrix, release checklist, changelog entry | Full CI; `npm pack`; Python wheel build | MVP ready for prerelease | Scope creep | Keep post-MVP features behind unsupported errors |

## 19. MVP Scope

MVP includes:

- Browser-only `Forge3DRuntime.create(canvas, options)`.
- Async WebGPU adapter/device/surface initialization.
- Canvas-backed render path.
- DPR-aware resize.
- Camera API.
- `Float32Array` terrain heightmap upload.
- Terrain render loop.
- Async PNG screenshot.
- Stable TypeScript declarations.
- npm package build.
- CI proving core wasm check, web wasm check, wasm-pack build, typecheck, and browser render test.

MVP excludes:

- Full Python/native feature parity.
- COPC/EPT/LAZ streaming.
- 3D Tiles rendering.
- COG/raster streaming.
- Mapbox Style parity.
- WebGL2 fallback.
- Rust thread pool/shared-memory requirement.
- TCP/stdin/native window concepts in browser API.

## 20. Post-MVP Roadmap

1. Raw typed-array mesh rendering and vector overlays.
2. Raster overlay `ImageBitmap` support.
3. Point cloud raw typed-array support with point budget.
4. Browser URL/Blob/File terrain inputs.
5. Scene JSON loader for `forge3d.scene.v1`.
6. Worker-based COPC/EPT metadata parsing.
7. 3D Tiles URL loader and b3dm/pnts rendering.
8. COG/raster range requests.
9. `wgpu` upgrade after browser CI and shader audit are stable.
10. Optional `OffscreenCanvas` runtime.

## 21. Risks And Mitigations

- **Engineering estimates.** Prototype canvas clear and terrain upload: 2-4 engineer-weeks after workspace split. Stable JS API, npm package, screenshot, and browser CI: 4-8 additional engineer-weeks. Python/native compatibility restoration after the split: 3-6 engineer-weeks depending on how many PyO3 wrappers move cleanly. Feature parity with Python/native viewer: multiple quarters because COPC/EPT/tiles/raster/style/viewer workflows require browser IO, workers, LOD/cache policy, and shader compatibility work.
- **PyO3 is spread through core-like modules.** Mitigate with `rg` inventory, wrapper-by-wrapper extraction, and `cargo tree` proof.
- **`wgpu` 0.19 browser surface API differences.** Keep all browser surface creation inside `forge3d-web`; compiler errors stay local.
- **Shader/browser incompatibilities.** Start with clear and terrain MVP; audit advanced effects before enabling them in web.
- **CI WebGPU variability.** Use a Windows Chromium required lane, browser capability diagnostics, and pixel probes.
- **Python behavior drift.** Keep `tests/test_api_contracts.py` and import smoke tests required after each wrapper migration.
- **Scope creep toward Python parity.** MVP feature table makes unsupported areas explicit.
- **Large mechanical move conflicts with active user changes.** Use feature branch/worktree when executing and commit phases separately.

## 22. Final Implementation Checklist

- [ ] Root workspace exists with four crates.
- [ ] `forge3d-core` has no PyO3, NumPy, wasm-bindgen, web-sys, winit, TCP, stdin, or path-only public browser APIs.
- [ ] `cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features` passes.
- [ ] `forge3d-python` builds `forge3d._forge3d` and existing Python imports still work.
- [ ] `forge3d-web` builds with `cargo check -p forge3d-web --target wasm32-unknown-unknown`.
- [ ] `wasm-pack build crates/forge3d-web --target web` passes.
- [ ] `Forge3DRuntime.create(canvas, options)` is async and owns browser WebGPU state.
- [ ] `resize`, `setCamera`, `setTerrain`, `render`, `screenshot`, and `dispose` are implemented.
- [ ] Typed-array validation rejects wrong lengths, wrong dtypes, zero dimensions, non-finite camera values, and disposed-runtime calls.
- [ ] Browser API does not expose NumPy, `PathBuf`, native windows, TCP, stdin, env vars, or blocking readback.
- [ ] TypeScript declarations are hand-authored and typechecked.
- [ ] Vite example renders terrain.
- [ ] Playwright tests prove nonblank canvas render, resize behavior, and screenshot Blob.
- [ ] Browser package dry-run contains JS, wasm, declarations, README, and licenses.
- [ ] Python maturin build and Python smoke/API contract tests pass.
- [ ] Native viewer code lives outside core/web paths.
- [ ] Release README documents browser support, MIME requirements, CORS/Range guidance, cache headers, and MVP exclusions.
