# Offline licensing, image arrays and benchmarks

W21 remains Partial: M08 is E until W20 map plate, SVG and PDF product gates
are integrated and tested. W20 is present after merging main, but its license
gate integration remains outstanding. M09 and E07 have verified browser implementations.
Import these APIs from
`@forge3d/web`. Try [the browser example](../examples/utilities.html).

## Licenses and Pro gates

```ts
import { configureLicenseIssuer, setLicenseKey, getLicenseInfo, requirePro, loadStyle } from '@forge3d/web';

configureLicenseIssuer(trustedIssuerPublicKeyHex); // Once, BEFORE any key is attempted.
await setLicenseKey(keyFromYourApplication);
requirePro('Mapbox style loading');
const style = await loadStyle(new File([styleJson], 'style.json'));
console.log(getLicenseInfo().status);
await setLicenseKey(''); // Explicit clear; no environment or automatic storage reload.
```

Keys use the native format `F3D-TIER-CUSTOMER-YYYYMMDD-signature`, with a
64-byte Ed25519 signature encoded as 128 hex characters. The signed UTF-8
message excludes the signature. PRO and ENTERPRISE share Pro access. Customer
IDs may contain hyphens and cannot contain whitespace. Invalid dates and
signatures are rejected with `LicenseError` (`code: LICENSE_REQUIRED`). An
invalid replacement leaves the preceding verified key unchanged.

`LicenseInfo.valid` means that the signature verified. Access depends on
`status`: `active` through the entire expiry day, `grace` through the following
14 days, then `expired`. An empty manager reports `missing`. Expiry is rechecked
on every gate using local calendar days, matching native `date.today()`, so a long-running tab loses access when
grace ends. Grace calls emit a renewal warning. Returned reports are copies and
exclude the key and signature. A clear or a newer successful key wins over an
older pending verification or storage read. A failing newer key does not cancel
an older pending valid verification.
An explicit storage load still verifies its stored key if an earlier pending
verification finishes during the read. Only a clear or a successful request
issued after that read started can supersede it.

Verification uses WebCrypto Ed25519 when supported. Unsupported WebCrypto
falls back to the exact self-hosted `@noble/ed25519@3.2.0` and
`@noble/hashes@2.0.1` SHA-512 implementation. The fallback also works without
SubtleCrypto. A negative verification result never retries with weaker rules.
There is no online validation, telemetry or dependency CDN.

The following product entrypoints require a verified active/grace key before
fetching or writing: `loadStyle`, `compileStyle`, `loadStyleLayers`, `saveBundle`,
`loadBundle`, `parseGeoJsonBuildings`, `parseCityJsonBuildings`, `loadBuildings`
and `loadBuildingTilesMetadata`. MapScene style and bundle adapters call these
same gates. MapScene building recipes produce `pro_gated_path` diagnostics
before loading unlicensed building sources. Plain style parsing, expressions,
geometry operations, PNG helpers and benchmarks remain available without a key.
`PRO_FEATURES` names map plate/SVG/PDF gates, but those names are not integrated
or tested product gates. The W20 implementations are present after merging main;
their license gate integration and tests remain outstanding.
This is the explicit M08 blocker; its status remains E.

`requiresPro(fn, feature, manager?)` preserves arguments, return type and `this`.
`requirePro(feature)` checks the package singleton. For isolated state, create
`new LicenseManager({ publicKeyHex, verifier: 'auto' })`; use its `setKey`,
`getInfo`, `requirePro` and `clear` methods. A manager with a different issuer
does not modify the package singleton's product gates. The default issuer is
the native **development** public key. Its test signing key is public in native
test history; it does not represent a production entitlement. Production apps
must call `configureLicenseIssuer(trustedPublicKeyHex)` before any nonempty
`setLicenseKey` or singleton `setKey` attempt. This configures the actual
package-wide product gates, not just an isolated manager. The issuer can be
configured only once. A pending, successful or failed nonempty key attempt
locks configuration; `clear()` does not unlock it. Invalid issuer hex fails
without consuming the configuration opportunity. `licenseManager.configureIssuer`
obeys the same one-time guard. Public keys are 32 bytes encoded as 64 hex digits.
Ephemeral test issuers are generated at test time; no private signing key is
embedded or copied for this configuration path.

Persistence is explicit through existing W02 storage contracts:

```ts
import { licenseManager, opfsByteStore } from '@forge3d/web';
const store = opfsByteStore('my-app-licenses');
await licenseManager.save(store);
licenseManager.clear();
await licenseManager.load(store); // Reverify stored bytes; corrupt data grants no access.
await store.clear();
```

IndexedDB and CacheStorage byte stores work through the same interface. Keys
are stored as UTF-8, not encrypted. Each realm/worker/package instance owns its
manager; applications must explicitly provision a key in each instance that
uses a gated API. The examples have a password input; the automated examples
receive a signed development fixture through sessionStorage.

Browser verification provides validity, expiry, grace and client API gating.
It is not tamper-resistant DRM: scripts, local clocks, storage and issuer
configuration are under client control. Sensitive server/data entitlements
must remain server-side.

## Image arrays, PNG and display

```ts
import { arrayToPng, pngToArray, displayImageArray } from '@forge3d/web';

const image = { width: 2, height: 1, channels: 4 as const,
  data: new Uint8Array([12, 34, 56, 0, 78, 90, 123, 1]) };
const png: Blob = await arrayToPng(image);
const rgba = await pngToArray(png); // Exact RGBA8, including hidden RGB at alpha 0.
displayImageArray(canvas, { ...rgba, channels: 4 });
```

`ImageArray` accepts Uint8Array/Uint8ClampedArray grayscale (1 channel), RGB (3)
and RGBA (4). Rows run from top to bottom with interleaved channels and no
padding. `imageArrayToRgba` returns an owned RGBA8 copy; grayscale and RGB gain
opaque alpha. `imageArrayToImageData` returns an owned browser ImageData.
`displayImageArray` resizes a caller-owned DOM canvas or OffscreenCanvas and
uses a 2D context without retaining resources.

`encodePng(width, height, rgba, options)` accepts Uint8Array and
Uint8ClampedArray byte views, including offsets, without copying the input view.
It and `Frame.toPng` retain their existing dimension-based contract; they do not
have the W21 image-array pixel cap. `imageArrayToRgba`/`arrayToPng` retain their
16,777,216-pixel cap.
`arrayToPng` defaults to browser CompressionStream deflate and falls back to
deterministic stored zlib blocks. `{ compression: 'none' }` gives identical
encoded bytes across engines. PNGs have filter 0 and no ancillary chunks.

`decodePng(bytes, { maxPixels? })` is synchronous and canvas-free.
`pngToArray(source, options)` accepts W02 URL/File/Blob/Response/typed-array/
stream sources, cancellation and byte limits. It returns `{width,height,data}`
with owned Uint8ClampedArray RGBA bytes. Decoder support matches native PNG
grayscale, RGB, palette, grayscale-alpha and RGBA at their legal 1/2/4/8/16-bit
depths, transparency, all five row filters and Adam7 interlace. It checks chunk
CRCs, ordering, dimensions, zlib checksum and exact inflated length. The hard
limit is 16,777,216 pixels and 128 MiB encoded input; `maxPixels` can lower the
pixel limit. Invalid PNGs fail with IO_ERROR, limits with RESOURCE_LIMIT_EXCEEDED.

`loadImage` first tries exact `decodePng`. On IO_ERROR or
RESOURCE_LIMIT_EXCEEDED it preserves the previous bitmap/Canvas decoder path
and its 256 MiB mesh limit. Browser-accepted trailing IEND bytes, oversized
palette transparency and a 4097x4097 1-bit PNG are covered in source/dist tests.
`pngToArray` stays strict and never falls back. `exportImage` uses the exact PNG
encoder. Other image types use browser codecs, with an HTMLImageElement/DOM
canvas fallback where needed. JPEG is lossy and Canvas may premultiply alpha;
use the strict PNG typed-array path for exact bytes.

## Operation benchmarks and memory budgets

```ts
import { runBenchmark, RendererConfig } from '@forge3d/web';

const report = await runBenchmark({
  op: 'array_to_png', width: 512, height: 512,
  warmup: 10, iterations: 100, seed: 0,
  renderer: new RendererConfig({ quality: 'low' }),
  budget: { maxP95Ms: 50 },
});
console.log(JSON.stringify(report));
```

Operations are `renderer_rgba`, `renderer_png`, `array_to_png`,
`png_to_array` and `custom`. Renderer operations take `target: session`, render
the caller's committed scene through the readback/screenshot path's own scene
pass, and await its completion. There is no extra target.render(). Native
`scene_rgba` maps to `renderer_rgba` over the caller's committed scene; the
unreleased duplicate operation was removed. Targeted operations record the
session's actual W02 RendererConfig, capabilities and memory reports. They never create a preset catalog or dataset
registry. PNG fixtures are generated deterministically from the recorded seed;
fixture creation is outside timed samples. For `custom`, provide an operation
returning a value or a Promise and optionally a W02 `memory` report callback.
`runBenchmarkSuite` runs operations sequentially. `renderer` is the actual
target config, an explicitly requested `options.renderer` config, or null when
neither was supplied. No default renderer config is invented for PNG/custom
operations.

The versioned `BenchmarkResult` has `schemaVersion: 1`, operation, dimensions,
seed, `coldMs`, warmup/iteration counts, raw `samplesMs`, `stats`, `throughput`, `renderer`,
`environment`, `memory`, `rendererStats`, `baseline` and `budget`. Stats include min, p50,
mean, p95, max and population standard deviation, with NumPy linear percentile
interpolation. Throughput is FPS and megapixels/second. The first operation
is timed separately as `coldMs`; it and subsequent warmups and setup are
excluded from steady samples/statistics/throughput. Operation count is exactly
1 + warmup + iterations. `timing: 'cpu-completion'` includes encoding/readback overhead and
must not be interpreted as GPU-only timing. `rendererStats` is explicitly null:
current W02 readback/screenshot paths do not update the session statistics.
Reporting the preceding explicit render would report a different frame.

Environment records browser UA, concurrency, pixel ratio, secure/isolation
signals and the target's adapter/features/limits. Unavailable capabilities or
memory are `null`. Memory records before/after W02 reports, current-byte delta,
and the greatest observed current/lifetime peak allocation. Budget checks
report named violations for `maxP95Ms`/`maxMemoryBytes`; unavailable memory
cannot pass a memory budget. Pass a prior `BenchmarkResult` as `baseline` to
compare steady p95. `maxRegressionPercent` defaults to native perf_sanity's 50%;
a larger increase adds the named `baselineP95Regression` violation. Baselines
must match schema, operation, dimensions, seed, timing and renderer config.
The report records baseline p95, tolerance, limit and percentage increase; the
percentage is null for a positive measurement over a zero baseline. Compare
environments separately before interpreting results. Cancellation and operation failures reject the
run. `maxDurationMs` defaults to five minutes and is checked between awaited
operations; it cannot preempt a Promise that the caller never resolves.

FND-07's `tests/browser/viewer-benchmark.ts` now exposes
`runViewerOperationBenchmark(page, options)`. It loads the existing frozen
terrain/manifest and measures real viewer screenshot completion through public
`runBenchmark`, returning its statistics, throughput, environment and budget
schema. The existing source benchmark test attaches it separately after
validating its v1 evidence. A real-browser test rejects uniform or incorrectly
sized captured output. The frozen v1 manifest, trace, goldens and original scheduling report
remain unchanged. The companion has renderer: null because the viewer does not
expose a W02 RendererConfig. Neither report establishes W00 physical-browser
qualification.

See [W21 verification](w21-evidence.md) for native provenance and runnable gates.
