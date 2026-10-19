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

The source contract is a generated, reviewed routing-intent lock, separate
from the presentation catalog; it does not independently prove correctness.
Its capture command and source-context audit are recorded in the lock.
The independent semantic audit checks original file/name ownership and rejects
substring matches such as accepts/depth as EPT and constructible as IBL.
Validation
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

Every one of the 24 regional examples has an explicit source identity and
native operation list. The 29 controls cover each example's own computation or
its original imported dependency: distinct Colorado/Platte IDW rules, PNOA
waterway masks/cropping, climate classification, road routing, GTFS transit,
building heights, city sun/flood propagation, smoke injection/advection, storm
envelopes, population heights, landcover processing, basin decoding/compositing,
rail projection, lighthouse relief and satellite grading/transitions.
Expected values execute unchanged Python helper ASTs from pinned source.
Erasing an operation or damaging its expected values must fail for each example.
Seven original DEM windows retain source-file/window hashes, bounds and CRS;
other cases explicitly use distinct bounded native-mini-DEM or typed controls.
The rendered examples use bounded
offline data; these are executable workflow migrations, not replacements for
the original publications' geographic datasets or visual reference images.

Original style and preset inputs are consumed by their workflows. Unsupported
style intent retains its exact diagnostics; explicit vector/label conversions
produce browser layers. Presets are applied to sessions, terrain analysis,
material, camera, lights and IBL. Prepared HDR lighting, weighted OIT and temporal
AA run on the GPU. A test observer outside the workflow module records actual
HDR load/prepare/bind calls, RGB readback, OIT mode, TAA history and all three
rigs' baked paths and independently sampled clearance. Erasing those observed
events fails the execution verdict even if stage return values claim success.
Layer, material, environment and water assertions compare RGB
against controls, ignoring opaque alpha. Browser fault injection suppresses
those contributions while claiming successful layer execution; it must fail.
Ten live controls cover these effects, point clouds, shadows, IBL, OIT, TAA
and invalid rig paths. Shadow checks use an explicit occluding ridge control;
regional scene shadow deltas are recorded separately because a planar crop
can cast no visible shadow. Quickstart PNG output comes from the viewer snapshot.
Video is counted as executed only when encoding produces a real artifact.
An unavailable codec and a missing Pro license are explicit outcomes.

Every tracked asset has a digest and either an exact native source or a
derivation record. Derivations name generators, input hashes, upstream sources
and conversion recipes; a creation commit alone cannot establish provenance.
Native text normalized to LF is distinguished from exact native bytes.
MiniDEM is identified as native data. Rainier records its source DEM and COG
conversion. W04/W05/W06 and later generated controls retain their authoring
generators. W09 captured controls retain historical kernel hashes and parameters;
the original W09 authoring harness is not archived, so these records do not
claim a reproducible W09 GPU replay.
The native Mapbox Streets fixture and new converted PNG/application controls
are included. The 33 native illustrations retain exact bytes and remain labeled
historical illustrations. Current example/test/generator source snapshots are shipped
with hashes for offline review; they are source text, not runnable installed
repository test suites. Historical links target the actual forge3d-web repository
and their Git objects are checked for both blob and tree links. All migration
JavaScript/HTML is hash-pinned by the asset gate; browser startup also checks
program and control-JSON bytes. A request-intercepted erased workflow module
must fail integrity before the gallery becomes ready. Binary streaming inputs
remain range-fetched and are fully hashed by the repository/installed gates.

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
license input; only tests configure the test issuer. Before that configuration,
browser tests assert blocked-license and LICENSE_REQUIRED for protected style
and bundle examples.

Run `npm run generate:w23`, `npm run verify:w23`, `npm run test:w23` and
`npm run test:package-consumer:w23`. Authoring oracles can be recomputed with
`python scripts/generate-w23-goldens.py --check` and
`python scripts/generate-w23-application-fixtures.py --check` (Python 3.13 with
NumPy 2.5.1, Pillow 12.2.0, SciPy 1.16.0 and rasterio 1.4.3 for authoring,
never for browser runtime). Recorded runs live in
repository `docs/parity/w23-verification.json`. W24 retains physical browser/GPU,
long traversal and final functional/visual release qualification.
