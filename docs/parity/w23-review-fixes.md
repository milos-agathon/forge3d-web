# W23 review corrections

These changes address the review of `3f11974f` against W23 in
[`2026-06-04-forge3d-browser-webgpu-wasm-runtime.md`](../superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w23--restore-documentation-examples-goldens-and-migration-guides).
The acceptance requirements are unchanged. Work is on `codex/w23-documentation`
in `D:/forge3d-web/.worktrees/w23`; other active checkouts are preserved.

| Review finding | Correction and regression evidence |
| --- | --- |
| High 1: deduplicated, disconnected examples | All 54 examples now run separate ordered pipelines. DEM normalization consumes the bundled DEM and matches a native NumPy oracle; triangles are drawn; all three camera rigs check clearance; a real multi-overview COG streams into terrain; original style/preset inputs affect rendering; HDR IBL, TAA, OIT and actual MP4 encoding run. Regional numerical transformations have independent native helper oracles. Browser tests assert per-example dataflow, live controls and disposal. |
| High 2: unrelated evidence routes accepted | Source-based corrections separate point clouds from atmospheric clouds, route removed claims to tombstones, and attach R12 to actual public API/instance-method contracts. A separate source contract pins APIs, suites and example operations. Full test declaration arrays are checked. Six semantic mutations and the Colorado catalog mutation must fail; unmapped artifacts are computed. |
| High 3: wrong repository links | Historical links target `milos-agathon/forge3d-web`; pinned Git objects are checked. Current browser evidence uses shipped source snapshots with hashes, avoiding unpublished-commit URLs. Existing affected guides and package repository metadata are corrected. |
| Medium 1: wrong API destinations | Explicit typed migrations replace unrelated generic fallbacks, including triangle reduction, clipmap configuration, texture LOD, terrain material sets, style conversion, export bounds and `colormaps.get`. Notes describe member-level conversions rather than implying same-signature aliases. |
| Medium 2: vacuous rendering checks | RGB comparisons ignore alpha and compare each layer/effect with a removal control. Browser injection suppresses materials, environment, water, vectors and point-cloud drawing; every suppression must fail. Video reports execution only after real encoding. |
| Medium 3: incomplete fixtures/provenance | Restored the native Mapbox Streets fixture, added a DEM normalization PNG and five application numerical controls, and retained W04/W05/W06 generator provenance. Every asset has concrete native, generator/manifest or Git ancestry provenance. Exact native bytes and normalized native text are verified separately. |
| Medium 4: structural-only negative controls | Added semantic catalog/API/suite/declaration mutations, unrelated native-source rejection, independently damaged numerical expectations and actual browser rendering faults. |
| Low: snippets and description | All 33 TS/JS fences compile; two complete examples compile strictly and execute in source, dist and installed browsers. The MapScene gallery description now matches its contents. |
| Low: license visibility | The gallery accepts the normal Pro key and reports `blocked-license` explicitly when absent. Automated tests configure a test issuer; no test key is shipped as a product entitlement. |

The verification record is [`w23-verification.json`](w23-verification.json).
The final clean installed-package run at `d46d2368` verifies all 193 shipped
asset hashes, including the 81 test-source snapshots under documentation.
All 54 pipelines, five rendering fault controls and both complete guide
examples pass in source, dist and installed Chromium. Repository checks pass:
1,960 unit cases, 33 W23 cases, 64 documentation cases, 118 browser-harness
cases and 628 infrastructure cases (one Unix UID ACL case is skipped on Windows).
Browser runs use Chromium preflight; physical browser/GPU and final release
qualification remain W24 work. Regional migrations use bounded offline data
and preserve computational/rendering stages; they do not reproduce the original
publications' full geographic datasets. Historical test routes identify relevant
current capability tests, without claiming execution of every Python assertion.
