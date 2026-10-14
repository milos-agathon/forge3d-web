# W20 implementation and verification

The implementation was checked against the monolithic native commit
`bf8db93233e5158f6d226991fc5d230832c2d806`, independently of earlier task claims.
The [coverage ledger](w20-native-test-coverage.json) accounts for all 82 test
definitions in `test_map_plate_layout.py`, `test_export_svg.py` and
`test_export_projection.py`. Exact source bytes and SHA-256 provenance are stored
under `tests/fixtures/w20/native` and checked by the unit suite. The native
reference runner executes 80 original tests successfully, skipping only two
unavailable native-extension imports; both projection functions have functional
numeric TypeScript ports. The W21 Pro-license hook is isolated in that runner.

Independent native controls include all 256 linear RGBA values for each core
palette, 18 anchor placements, 12 geodetic scale cases and display-space legend
bytes. Browser layout also checks the exact fitted map rectangle, inset bounds
and border. SVG smoke rasterizes actual polygon holes, lines and labels; PDF
smoke inspects page size, even-odd path operators, text, embedded fonts and halos.

Local verification commands:

```sh
python scripts/generate-w20-native-fixture.py
npm run test:unit
npm run build:wasm
npm run build:ts
npm run prepare-dist
npm run test:api
npm run test:package
npm run test:w20
python -m pip install -r scripts/requirements-w20.txt
npm run test:package-consumer:w20
```

The full unit run passes 1,784 tests across 78 files, including 103 W20 tests.
The source/dist browser suite contains 18 cases, including all 33 native plate
cases as named steps, exact PNG decode, JPEG smoke, 30 replacement/export cycles,
standalone deterministic SVG/PDF, worker/main pixel equality, OPFS, file/URL/CPT/
JSON imports, label/vector adapters, actual MapScene terrain output, simulated
device loss and operation with unavailable WebGPU.

The installed gate rebuilds WASM from source and requires a clean committed
tree. It installs the real npm tarball in a separate temporary consumer, compiles
public TypeScript declarations and runs the nine dist cases from that installed
directory with self-only script/worker/font/connect policy. It never serves
`src-ts` or resolves runtime dependencies through the source checkout. The
independent pinned PyMuPDF tool reopens the exported PDF, extracts its Unicode
text, checks font/vector objects and rasterizes exterior, hole, line and text
pixels. The gate records the revision, package/WASM hashes, test JSON, attachments
and independent PDF render result in `test-results/w20-*`.

Browser evidence is local Chromium preflight. Physical-browser release
qualification remains the separate W24 gate. W20 uses CPU/Canvas resources and
owns no WebGPU allocation. See [cartographic APIs and ownership](cartography.md)
for font, image, source and memory limits and the native-to-browser adaptations.
