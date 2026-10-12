# W17 verification

The implementation is audited against frozen native source bytes, rather than
earlier completion claims. The fixture manifest records full commits and SHA-256
digests for the acceleration, SDF and tracing sources and eight shipped test
modules. Unit tests verify every frozen digest.

| Family | Native outcome | Browser implementation and proof |
| --- | --- | --- |
| G09 | SAH, Morton/radix LBVH, refit, query, stats | Rust/WASM SAH; TypeScript reference; GPU 15-pass stable radix, heap topology and bottom-up refit; analytic million-ray test uses GPU-generated nodes |
| G10 | Six primitives, six CSG operations, bounds, material selection, hybrid traversal | Shared packed 80/32-byte model; Rust/WASM and TypeScript topological evaluation; GPU sphere tracing and mesh/SDF nearest hit |
| G11 | Deterministic progressive path tracing and queues | Independent pixel/sample xorshift streams; megakernel and ray/intersect/shade/shadow/scan/compact stages; exact engine replay hashes |
| G11 | Lighting, materials, AOVs | Point/directional/disc emitters; Lambert, isotropic/anisotropic GGX and dielectric/TIR; direct BRDF and sampled bounces; linear beauty and lighting AOVs; depth/IDs, AO and bent normals; HDR/RGBA frame integration |
| G11 | ReSTIR, guiding, media, cache | Weighted candidates and temporal/spatial reuse; online PDFs; RGB majorant free flight and HG; bounded content cache restoring progressive state |
| W02 | Ownership and service contracts | Transferable worker packets, cancellation, explicit CPU backend, typed admission/device errors, idempotent disposal and loss replay |

The native Python path-tracer facade generated synthetic images and its geometry
methods were no-ops. Browser tests exercise actual geometry instead. The native
CPU cylinder formula disagreed with its WGSL and Python signed-distance formula;
the port uses the signed formula. A degenerate capsule becomes a sphere. The SAH
port fixes the native root-last/refit-root-zero mismatch. CSG DAG evaluation is
topological so shared subtrees do not cause recursive exponential work. Native
stored-only performance controls and hardcoded zero metrics are replaced by
bounded traversal and observed memory reports; synthetic statistics are not
presented as measured behavior.

Single sphere and plane normals use analytic gradients on CPU and GPU. The
finite-difference sphere gradient amplified float cancellation in narrow GGX
highlights; the analytic gradient fixes that without changing distance or hit
semantics. CSG and the other primitives retain the shared central-difference
gradient.

`trace-sdf-v1` contains 65,536 triangles, 128 sphere primitives (255 DAG nodes),
1,048,576 analytic rays and seed 1597463007. An independent Python generator
pins geometry, rays and expected hit bytes. Extra rays exercise the lower sheet
and all 128 spheres. The frozen million-ray set is an exact dyadic hash oracle,
not numerical-tolerance evidence by itself. A separate 567-query regression uses
rotated triangles, oblique non-dyadic rays and irregular leaf counts. Another
512 samples check SDF values away from sphere centres against an analytic oracle. The image oracle integrates the fixture's Lambert/environment
response analytically. The browser test checks strictly decreasing RMSE at
1/4/16/64 spp, Gaussian-window SSIM ≥0.98 at 64 spp, exact repeat/engine hashes,
CPU color tolerance 1e-5 and full pixel coverage. A blank-frame negative control
must fail SSIM.

Headed Firefox 150.0.2 with default preferences reproduced one-ULP engine
differences in the pre-correction `c389e72` runtime: maximum absolute color
error was 5.960464477539063e-8 on 21 convergence channels and
2.9802322387695312e-8 on 15 channels in the failing material comparison.
WGSL [permits arithmetic fusion and reassociation](https://www.w3.org/TR/WGSL/#floating-point-reassociation-and-fusion).
The runtime now places observable float32 bit boundaries around environment,
emission and light contributions before accumulation. A separate scattering
regression reproduced relative engine error of 3.2393490204208564e-7 after one
bounce and 1.051981634241634e-6 after three. Float32 boundaries on the free-flight
log result and medium exponent inputs remove that difference without reducing
precision. The focused local Firefox reproductions pass unchanged exact color
hashes and direct/indirect AOV equality. The serial
review seed ensemble allows 600 seconds for cold pipelines and GPU readbacks;
phase timings identify any stalled workload without changing its assertions.
All 11 source checks pass on local Firefox and Chromium, and all 11 installed
Chromium checks pass on the committed correction. Raw reports, exact parity
results and the installed tarball digest are bound to `0a46179` in
[the Firefox correction evidence](../../../docs/parity/w17-firefox-fix-evidence.json).

Candidate RIS is checked against an exhaustive 50-light reference, with error reduction
above 40%. Reuse is compared at equal sample/candidate counts, checked against
an analytic two-light mean across eight seeds, and compared between CPU/GPU with
zero-weight histories. Directional guiding learns an emissive wall and must reduce
variance after training; clamped CPU/GPU weights are compared. Lit absorption
checks both camera and shadow paths; RGB scattering checks actual in-medium
lighting and CPU/GPU engine parity. Media is also checked against RGB Beer attenuation; GGX/glass/area lights
must render covered finite images with engine agreement and CPU error below
0.001 relative to max(1, CPU value). Unequal GGX axes must change the image;
normal-incidence BRDF and reciprocity have independent unit checks. Cache continuation,
including guiding and reservoirs, must equal a fresh render. Cancellation,
typed limits, device loss/replay and 30 disposal cycles are covered.
Pending scene updates and device recovery hold the same mutation lock as
rendering. Disposal during asynchronous pipeline creation releases the late GPU
resources and rejects the pending operation. A browser regression counts actual
GPU buffer destruction, independently of the tracer's memory ledger. All 30
disposal cycles and the full-scene stress use the same allocation observer. A
deliberately retained buffer proves the observer detects a leak. Failed recovery
and device loss during pending pipeline creation must reject and release buffers.

GPU storage layouts are independently checked by Naga: parameters 304 bytes,
hit 64, path 192, reservoir 80 and pending queue 128, with eight storage bindings. Every member offset is checked, including LBVH
and query records. Host packing has independent material/light/scene assertions.
SDF temporary arrays use per-invocation private storage. This avoids a driver
compiler stall on the 255-node full fixture while retaining the same evaluator.

The installed gate builds, packs and installs the actual tarball into a temporary
consumer, typechecks its public surface, then serves its installed `dist` and
assets. Source module routes are unavailable. It records revision, package hash,
test reports and optional 600-second local stress under `test-results`.

The local 32×20 stress viewport does not qualify W00's pinned 1920×1080 RTX 3070
Linux or Intel Iris Xe Windows profiles. Adapter/driver/OS attestation and their
16.7/33.3 ms p95 gates remain pending on those physical hosts. No physical-profile
pass is inferred from Chromium preflight or from an HTTP 200 response.

Commands:

```text
npm run test:w17
npm run test:package-consumer:w17 -- --soak
cargo test -p forge3d-web --lib
cargo test -p forge3d-core --lib --no-default-features --features webgpu
```

Native public mappings, tile enumeration and AOV Blob export are listed in
[the tracing guide](tracing.md) and covered by source/installed regressions.
