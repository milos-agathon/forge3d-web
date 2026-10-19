# W23 evidence coverage

W23 supplies browser migration guides, executable example pipelines, converted
numerical controls, preserved native illustrations and fixture provenance.
Capability support and physical-browser qualification remain recorded by their
owning tasks; documentation does not promote an unsupported feature.

The generated [coverage ledger](migration-coverage.json) routes every W00
artifact: 1,792 native test definitions, 191 named native test files, 54 example
assets, 88 documentation assets, 430 documentation features, 220 root exports,
216 Scene methods, public definitions/modules and changelog records. All 91
rows and 21 tombstones have destinations. [Features](features.md),
[support](workflow-support.md), [Python migrations](python-api-map.md),
[examples](examples.md) and [documentation](native-documentation.md) derive
from this inventory.

Source-based routing corrects W00 point-cloud/cloud confusion and sends removed
or unverified PLY, Draco, TV11, HUD, automatic water and Python-adapter claims to
their tombstones. R12 uses public declaration, live ESM/class/instance-method
and removed-API contracts, alongside scene/session/offline suites.
`capability-test-route` identifies relevant current tests; it does not assert
one-for-one translation or execution of every historical Python assertion.

The source contract is separate from the presentation catalog. Validation
rejects rerouting to unrelated existing capabilities, replacing APIs with
unrelated existing exports, erasing example operations, changing suite owners
and truncating test declarations. The unmapped list is computed and generation
fails on invalid coverage. Historical Git-object/SHA-256 and independent Python
AST audits check the source inventory and critical example calls.

Each selected native example gets its own ordered pipeline. Dataset, analysis,
terrain, overlays, geometry, lighting, frames and exports carry data forward.
The single-tile pipeline normalizes the actual bundled DEM and compares every
RGBA byte with an oracle executing the historical NumPy main(). The triangle
pipeline renders its mesh. All three terrain rigs check sampled clearance.
The COG pipeline reads overview/tile grids, checks cache hits and budget, and
uploads a real Rainier COG through TerrainStreamer before drawing.

Regional analysis ports include IDW relative elevation, climate quantiles and
classification, travel-time Dijkstra/speed parsing, roof solar orientation and
satellite transition planning. Their numerical controls execute unchanged
Python helper bodies extracted from pinned source. Browser negative controls
damage those expectations and must fail. The rendered examples use bounded
offline data; these are executable workflow migrations, not replacements for
the original publications' geographic datasets or visual reference images.

Original style and preset inputs are consumed by their workflows. Unsupported
style intent retains its exact diagnostics; explicit vector/label conversions
produce browser layers. Presets are applied to sessions, terrain analysis,
material, camera, lights and IBL. Prepared HDR lighting, weighted OIT and temporal
AA run on the GPU. Layer, material, environment and water assertions compare RGB
against controls, ignoring opaque alpha. Browser fault injection suppresses
those contributions while claiming successful layer execution; it must fail.
Video is counted as executed only when encoding produces a real artifact.
An unavailable codec and a missing Pro license are explicit outcomes.

Every tracked asset has a digest and concrete native, generator/manifest or Git
ancestry provenance. Native text normalized to LF is distinguished from exact
native bytes; W04/W05/W06 oracle controls retain their source/replay generators.
The native Mapbox Streets fixture and new converted PNG/application controls
are included. The 33 native illustrations retain exact bytes and remain labeled
historical illustrations. Current example/test source snapshots are shipped
with hashes for offline review; they are source text, not runnable installed
repository test suites. Historical links target the actual forge3d-web repository
and their Git objects are checked.

All TS/JS code fences compile against public declarations. Application-owned
context in fragments has explicit types; complete checked examples compile
strictly and their generated functions execute in the browser. The installed
gate builds, packs and installs into a clean temporary consumer, checks shipped
links/types/assets, and executes the pipelines and negative controls under
strict CSP with HTTP ranges. It serves only installed files, with no repository
implementation or fixture routes.

Single-example viewers retain controls for their actual scene/point-cloud
content. Changing runs or hiding the page removes controls, disposes owners,
cancels work and revokes download URLs. Browser checks exercise live controls,
artifact bytes and release of prior owners/URLs. Pro examples use the normal
license input; only tests configure the test issuer.

Run `npm run generate:w23`, `npm run verify:w23`, `npm run test:w23` and
`npm run test:package-consumer:w23`. Authoring oracles can be recomputed with
`python scripts/generate-w23-goldens.py --check` and
`python scripts/generate-w23-application-fixtures.py --check` (NumPy required
for these authoring commands, never for browser runtime). Recorded runs live in
repository `docs/parity/w23-verification.json`. W24 retains physical browser/GPU,
long traversal and final functional/visual release qualification.
