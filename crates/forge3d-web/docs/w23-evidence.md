# W23 evidence coverage

W23 restores migration documentation, example workflow routing, historical
illustrations and digest-pinned fixture/golden provenance. It does not change
the functional status of any capability or certify a browser/GPU profile.

The generated [coverage ledger](migration-coverage.json) has one entry for every
W00 artifact, including 1,792 native test definitions, 191 named native test
files, 54 example assets, 88 documentation assets, 430 documentation features,
220 root exports, 216 Scene methods and the public-definition/module/changelog
inventory. All 91 rows and 21 tombstones have concrete destinations. The
[feature index](features.md), [support index](workflow-support.md),
[Python map](python-api-map.md), [examples](examples.md) and
[documentation map](native-documentation.md) are generated from that ledger.

`capability-test-route` means that the individual native definition is routed
to named current suites for its capability. It is not a claim that every
native assertion has a one-for-one port or was executed by the W23 gate. Owner
suites and their more detailed per-test coverage ledgers remain the behavioral
evidence. `browser-workflow` identifies executable consolidated examples;
`tombstone` preserves an explicit retired/diagnostic disposition. No evidence
kind permits an unmapped record or a silent no-op.

`generate:w23` verifies all 541 immutable source objects against Git and SHA-256
before generating coverage. It preserves the original native illustrations at
their exact bytes. `verify:w23` validates unique/exhaustive ownership, concrete
test declarations, public TypeScript entry points, all local documentation
links, code-fence syntax/imports, checked TypeScript examples and asset digests.
Its negative controls remove records, delete example routes, invent APIs,
damage asset bytes and change test digests to prove the gates reject drift.

The asset index records every checked-in fixture/golden and bundled runtime
asset. It links byte-identical historical sources when available and keeps
owner provenance files for converted/native-derived fixtures. Browser-only
regression assets are labeled separately; they are not upgraded into native
goldens. The gallery's 16x16 terrain and small overlay are analytic browser
inputs. COG and LAZ inputs retain their existing W08/W16/W22 provenance.

The installed-package gate packs and installs the npm artifact into a temporary
consumer, compiles the guide examples against its declarations, validates all
shipped example resources and executes every gallery workflow from that
installation. The server exposes only the installed package, supports byte
ranges and enforces self-hosted workers/WASM with strict CSP. Source routes
and repository fixtures are unavailable to the consumer.

The gallery verifies rendered coverage, requested layer execution, PNG byte
round trips, deterministic frame timestamps, mesh output, CRS controls,
dataset contents, bundle layers and disposal. WebCodecs may return its exact
unavailable-codec diagnostic. Pro composition is tested with the test issuer
fixture, and the user-facing gallery uses the normal license input.

Run `npm run generate:w23`, `npm run verify:w23`, `npm run test:w23` and
`npm run test:package-consumer:w23` to reproduce. Recorded run details live in
the repository's `docs/parity/w23-verification.json`. Physical reference
hardware, long traversal budgets and final 100% functional closure remain W24
release gates; a zero-unmapped coverage report does not satisfy those gates.
