# W16 laz-perf 0.0.7 security review

**Status: pending independent sign-off.** Prepared by Codex on 2026-10-10.
Independent reviewer: pending. Sign-off date: pending. This document supplies
review evidence; its author has not approved the dependency. W16 stays Partial
and G02/G03/G04 stay P until an independent reviewer signs this review and the
two W00 hardware lanes qualify.

## Scope and provenance

The reviewed production asset is the immutable, lock-controlled npm
`laz-perf@0.0.7` archive. Its SHA-256 is
`7585aa5e425443c639a2580548ebb8c3eed3124bacd7eebbf3ab0fbde2d8e0c4`;
a fresh registry download matched that digest. The dependency lock's SHA-512
integrity is also unchanged. No rebuilt asset is installed into the package.

[npm's version metadata](https://registry.npmjs.org/laz-perf/0.0.7) identifies
the published source as `d0d3047e05221421fa0b02b3da4e93797edb2c52`, not
`f2e7491902dc06bf4ce0a4577d3af3b98f280b2a`. The latter is the lock's
**license provenance commit**. Its COPYING is unchanged from the published
source; its newer decoder code and checked-in WASM differ. Rebuilding that
newer decoder would be a substitution requiring an ADR. The actual release
source is pinned here explicitly, without changing the dependency lock.

The npm web WASM also exactly matches the published source commit's checked-in
`js/src/laz-perf.wasm`. [The comparison](w16-security/published-source-comparison.json)
records every section hash, import, export and memory limit. The source tree
at the release commit is `7345a176f1454c4cdcc33f037e272b10e8960a49`.
The [toolchain manifest](w16-security/toolchain.json) binds the source/SDK
trees, observed compiler/linker/optimizer digests and rebuilt assets.

## (a) OSV and GitHub advisory triage

[Captured API requests and responses](w16-security/advisories.json) were
recorded at `2026-10-10T13:29:45.092494+00:00`. All returned HTTP 200:

| Primary source and exact query | Observed result | Triage |
| --- | --- | --- |
| [OSV API](https://api.osv.dev/v1/query), npm laz-perf 0.0.7 | `{}` | No matching published advisory |
| OSV API, published source commit d0d3047e05221421fa0b02b3da4e93797edb2c52 | `{}` | No matching published advisory |
| OSV API, license provenance commit f2e7491902dc06bf4ce0a4577d3af3b98f280b2a | `{}` | No matching published advisory |
| [GitHub global advisories](https://api.github.com/advisories?ecosystem=npm&affects=laz-perf%400.0.7&type=reviewed&per_page=100), reviewed npm advisories affecting laz-perf@0.0.7 | `[]` | No matching published advisory |
| GitHub global advisories, identical package/version with type=unreviewed | `[]` | No matching published advisory |
| GitHub global advisories, identical package/version with type=malware | `[]` | No matching published advisory |
| [Upstream repository advisories](https://github.com/hobuinc/laz-perf/security/advisories) and repository advisory API | `[]`; no published advisories | No upstream advisory to map to either commit |

These are time-bound database results, not a safety certification. They do
not cover unpublished reports or a vulnerability lacking package/commit
mapping. The captures retain query bodies and response digests. Re-query with:

```sh
python scripts/review-w16-laz-perf.py advisories --output docs/w16-security/advisories-new.json
```

Source-history triage also inspected upstream
[2c21fa0402af5679314ad518e74c076021753554](https://github.com/hobuinc/laz-perf/commit/2c21fa0402af5679314ad518e74c076021753554),
which initializes several decoder fields to resolve Coverity warnings. That
change postdates 0.0.7 and is absent from the locked binary. The ordinary
arithmetic constructors in 0.0.7 already call `init()`; the added defaults alone
do not establish an exploitable bug. Copy/edge paths and malformed input remain
subjects for independent review. No undisclosed fix has been imported.

## (b) Pinned-source WASM rebuild

The audit rebuilt the exact npm source commit with the toolchain pinned by
its `js/wasm.sh`: **Emscripten 3.1.20**, Emscripten source revision
`5d878c99921ec247d34fb26a20b5a13d60d69e93`.
The emsdk checkout is pinned to release-tag commit
`21611d2a507fad73385120d89e05a794666070ae`; its release map pins the SDK
to `d92c8639f406582d70a5dde27855f74ecf602f45`.
The audit used that official Linux SDK under Ubuntu 24.04/WSL2, CMake 3.28.3,
Python 3.12.3 and a single build job. It ran the upstream CMake target, with
the same Release and web-environment settings as upstream's Docker command.
Source and SDK tracked content were verified unchanged before compilation.

The resulting **WASM and web factory both match npm byte for byte**:

| Asset | Bytes | SHA-256, npm and rebuilt |
| --- | --- | --- |
| `lib/web/laz-perf.wasm` | 214,351 | `9c1802bc31b567dd4aa1ce9ab010e7e51e095dc42af8379b474ae6f221a9327f` |
| `lib/web/laz-perf.js` | 87,228 | `d9a91a08979dd9f717884e33c9f61997e79122da2c02be8414a5d7e99061985e` |

[The rebuild log](w16-security/rebuild.log) retains exact compile/link commands,
versions and successful target completion. Its SHA-256 is
`1d0e077b5c1d8760e7c942dc8cbbcdd9ec6964937a1c10fc2f546cfe50e58a1f`.
[The comparison report](w16-security/rebuild-comparison.json) verifies the
complete binary, without normalizing headers or stripping sections: all ten
sections, all 23 imports and 23 exports match; `byteDifferences` is empty.
There are no custom sections. Both binaries define one internal linear memory
with minimum 4 pages (262,144 bytes) and maximum 32,768 pages
(2,147,483,648 bytes). This ceiling is separate from Forge3D decoded-byte limits.

The linker retained upstream `--bind`, `ASSERTIONS=1`, `INITIAL_MEMORY=262144`,
`TOTAL_STACK=65536`, `ALLOW_MEMORY_GROWTH=1`, `WASM=1`,
`BINARYEN_METHOD='native-wasm'`, `MODULARIZE=1`, `DYNAMIC_EXECUTION=0`,
`EXPORT_NAME=createLazPerf`, `ENVIRONMENT=web`, `-O3` and `-DNDEBUG`.
Build warnings about linker settings during object compilation are recorded;
those settings are applied by the final successful link command.

Reproduction, using fresh temporary directories and installed Git, Python,
CMake and make, from the package directory:

```sh
git clone https://github.com/hobuinc/laz-perf.git /tmp/w16-laz-source
git -C /tmp/w16-laz-source checkout --detach d0d3047e05221421fa0b02b3da4e93797edb2c52
git clone https://github.com/emscripten-core/emsdk.git /tmp/w16-emsdk
git -C /tmp/w16-emsdk checkout --detach 21611d2a507fad73385120d89e05a794666070ae
(cd /tmp/w16-emsdk && ./emsdk install 3.1.20 && ./emsdk activate 3.1.20)
bash scripts/rebuild-w16-laz-perf.sh /tmp/w16-laz-source /tmp/w16-emsdk /tmp/w16-laz-build
python scripts/review-w16-laz-perf.py compare \
  --published node_modules/laz-perf/lib/web/laz-perf.wasm \
  --rebuilt /tmp/w16-laz-build/cpp/emscripten/laz-perf.wasm \
  --output /tmp/w16-laz-comparison.json
```

The helper checks both Git commits, the Emscripten version/revision and the
four Linux SDK component digests before building. It requires a new build
directory and never writes `assets/laz`.
The shipped factory retains the existing ESM export footer; the shipped WASM
remains the exact npm binary. A successful rebuild establishes the tested
binary/source relationship, not correctness of all decoder paths.

## (c) Deterministic worker fuzz

The committed [corpus seed](../tests/fixtures/w16-security/laz-corpus-seed.json)
uses xorshift32 seed `1450659856`, 64 mutations and one untouched real-data
control for each of four source slices. They are the coarse root and a detail
chunk of overview COPC, an original ellipsoid COPC chunk and the original
Autzen LAZ file. Every source file must match the independent fixture manifest.

[The runnable script](../scripts/fuzz-w16-laz.mjs) drives the production worker
handler with the unchanged npm codec. Its diagnostic worker observes actual
WASM instantiate/grow events; it does not substitute a decoder or alter memory.
Mutations cover truncation, compressed-stream bit flips, zero/255 runs, count
forgery, layer-length redistribution preserving the aggregate length, VLR
corruption and appended bytes. Preserving chunk directories in arithmetic
mutations lets cases reach the native decoder rather than only header rejection.

Run cases one at a time, after building TypeScript/dist:

```sh
npm run build:ts
npm run prepare-dist
node scripts/fuzz-w16-laz.mjs
```

The seed fixes a 1,000 ms execution deadline, 3,000 ms observed-completion bound
and an 8 MiB input/decoded-output limit. Each case must yield validated output
or a `Forge3DError`. All four controls must produce valid output; the two COPC
roots and Autzen must also match the independent point/color hashes. The detail
chunk control is checked against its pinned hierarchy count and array layout;
no independent point/color hash is claimed for that slice.
The report retains each mutation hash, outcome/code, elapsed time and actual
WASM high-water observations. Recovery must decode the real root again with
zero active/queued jobs after the corpus. The script writes the report before
asserting its aggregate bounds, so failures remain available for diagnosis.

The final clean-tree run on `b869e17acf58f1c68770d0079700e1d4bfb2f18d`,
Windows/Chromium `148.0.7778.96`, completed **260 cases: 120 valid outputs,
129 INVALID_INPUT errors and 11 RESOURCE_LIMIT_EXCEEDED errors**. There were
zero untyped errors. Maximum job time was **157 ms**, below the 1,000 ms
deadline and 3,000 ms completion bound. Peak observed WASM heap was
**7,274,496 bytes**, below the binary's declared 2 GiB ceiling; input and
decoded-output allocations remained within their separate 8 MiB checks.
The real 512-point root decoded again after the corpus, with zero active or
queued jobs. No case in this corpus needed deadline termination; the separate
source/dist infinite-WASM tests exercise termination, replacement and queued
real-LAZ recovery on both abort and deadline.

[The complete final report](w16-security/fuzz-report.json) has SHA-256
`33ef7407b94ba3283caa425ec1b35aa7c87e8b0d70367a4e4d216f760b5c7fd5`.
It binds the seed, deterministic corpus, fixture manifest, unchanged codec,
script and diagnostic worker bytes. Successful and typed-error heap telemetry
travels with the job result, avoiding ordering assumptions between separate
worker message channels. [The initial debugging observation](w16-security/fuzz-initial-debug.json)
is preserved separately; it preceded the final decoder-hardening rebuild and
is not the final source/artifact binding. These observations do not supply
independent sign-off.

## (d) Remaining risks and sign-off

- `ChunkDecoder.open` receives an input pointer without a chunk byte length.
  Its C++ input callback advances that pointer without a logical input bound;
  `MemoryStream::getByte` also indexes its vector without a bounds check.
  Layer-directory validation and zero padding reduce obvious failures but do
  not prove all arithmetic reads remain within their encoded streams.
  WASM traps at linear-memory boundaries, not at C++ allocation boundaries.
  A mutated stream may produce finite, structurally valid but incorrect points
  or read other data in the same worker's heap. Real controls prove conformance;
  mutation outputs are not authenticated source data.
- The codec's **hard WASM ceiling is 2 GiB**, not the 8 MiB fuzz decoded-output
  budget or the layer's allocation ledger. A hostile internal allocation can
  grow memory before a job deadline fires. Fuzz heap observations bound this
  corpus; they do not prove a lower worst-case allocation for arbitrary input.
  Browser/process RSS is not attributed per job by this harness.
- Worker termination bounds stuck native CPU execution and releases the owned
  worker. Browser scheduling can delay deadline callbacks; the fuzz completion
  bound is measured independently of the requested deadline. Concurrent caller
  workers can multiply native-memory exposure. Independent review must assess
  acceptable worker count, exposure and residual denial-of-service risk.
- This deterministic corpus is finite and does not replace coverage-guided
  native sanitizer fuzzing or analysis of all point formats/extra-byte paths.
  The audited build preserves the upstream Release flags, including `-DNDEBUG`.
- Empty advisory queries and byte reproducibility do not eliminate unknown
  defects. The dependency remains experimental and its newer upstream fixes
  are not automatically available to the exact-version lock. Any replacement
  build/version requires an owner-approved ADR and the same fixture suite.

An independent reviewer must inspect the above evidence and residual risks,
record their name and date, and explicitly approve or reject consumption.
Neither this document nor its generating agent supplies that approval.
