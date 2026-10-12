# W17 review fixes

Code revision: `8171a0dd5a7e6edca12cf83244576763b115ec0d` (base for this review: `ab5e331`).
No subagents were used. The primary checkout is unchanged.

A subsequent guiding CDF correction is recorded in [follow-up evidence](w17-guiding-fix-evidence.json).
CPU and GPU now consume the same host-generated float32 probabilities and cumulative
boundaries. A deterministic 32×24 floor/wall case reproduced CPU bin 7 versus GPU
bin 6 before the fix; both select bin 7 afterward. Three seeds, including that
boundary control, are compared after every sample through 32 spp on both GPU engines.
The prior 600-second stress below remains bound to its original code revision.

| Reported defect | Correction | Regression proof |
| --- | --- | --- |
| Empty GPU LBVH leaves and runaway traversal | Quotient/remainder leaf partition fills every leaf; CPU/GPU traversal rejects inverted bounds and zero-child leaves | 12 irregular counts, 567 CPU/WASM/GPU comparisons, topology-preserving refits |
| Failed GPU recovery falls through to CPU | WebGPU renders require a live GPU; failed recovery/rollback stays unavailable until explicit recovery | unit rollback/recovery failures, real GPU recovery failure, loss during pending pipeline compilation |
| Lit media omit transmittance and scattering illumination | Beer attenuation on shadow connections; in-medium light sampling with HG phase | analytic absorbing slab includes both paths; nonzero RGB scattering and CPU/engine parity |
| ReSTIR CPU/GPU streams and history differ | Identical compatible-neighbor admission/RNG use; per-sample reservoir clear on misses/scatters | two lights, spatial/temporal reuse, both bias modes and exact engine agreement |
| Guiding rewards local direct lighting | Train inverse-PDF weighted continuation radiance before clamping; 20% uniform exploration | zero local-direct reward, clamped CPU/GPU weight parity, directional wall learning and variance reduction after training |
| Equal explicit GGX axes ignored | Isotropic evaluation and sampling use explicit alpha; unequal axes retain anisotropic formulas | analytic normal-incidence/sample equivalence, real GPU image equivalence |
| Render/cache lock gap | One lock covers keying, sampling, state capture and cache insertion | microtask mutations and pending cache export rejected; cached accumulation remains intact |
| SDF/triangle ID collision | SDF default ID is reserved `0xffffffff`; GPU kind uses hit steps; TS/WASM reject that triangle ID | max allowed mesh ID remains a mesh; SDF reserved-ID and Rust validation checks |
| Throwaway main-thread BVH builds | Validated storage preparation and tree cloning avoid SAH/LBVH rebuilds; timings include preparation | prepared tree/clone validation and CPU/WASM/GPU build stats |
| Non-transferable worker query/SDF results | Packed ray records and typed distance/material arrays | transfer detaches every buffer; IDs, material bits and misses preserved |

Stronger checks also retain zero-weight ReSTIR proposal counts and expire history on deterministic sample windows. The two-light analytic mean is checked across eight independent seeds; reuse variance is compared with identical candidate/sample counts. Guiding variance is measured after a 256-sample training period, against uniform sampling.

The frozen million-ray fixture remains an exact dyadic hash oracle. Numerical checks separately exercise oblique rays on rotated triangles, irregular BVH counts, and 512 off-centre SDF points. Naga checks every struct member offset, and host scene-packing assertions independently check raw material/light/triangle/SDF words.

Disposal/stress checks observe real GPU buffer creation and destruction. A deliberately retained buffer must be detected. The tracer releases retained scene/accumulation references and reports live buffer sizes; its ledger is not a browser heap measurement.

Native public outcomes have explicit G09-G11 mappings in the [tracing guide](../../crates/forge3d-web/docs/tracing.md). BVH property/validation methods, scanline tiles and AOV EXR/PNG Blob export now have direct public tests. AOV exports are decoded and checked, not accepted merely because a Blob was returned.

Current test results, revision/package digests and raw browser reports are in [local evidence](w17-local-evidence.json). The new 600-second installed stress uses the same fixed code revision as functional verification. The W00 pinned 1920×1080 RTX 3070 Linux and Iris Xe Windows profiles remain unqualified: local 32×20 stress cannot supply those hosts, budgets or adapter/driver/OS attestations.
