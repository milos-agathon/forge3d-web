# Offline licensing, image arrays and benchmarks

W21 implements M08, M09 and E07 in the browser. Import these APIs from
`@forge3d/web`. Try [the browser example](../examples/utilities.html).

## Licenses and Pro gates

```ts
import { setLicenseKey, getLicenseInfo, requirePro, loadStyle } from '@forge3d/web';

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
on every gate using UTC calendar days, so a long-running tab loses access when
grace ends. Grace calls emit a renewal warning. Returned reports are copies and
exclude the key and signature. Clearing or setting a newer key wins over an
older pending verification or storage read.

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
`PRO_FEATURES` also names the map plate/SVG/PDF gates for W20-owned entrypoints;
this branch's baseline does not contain those W20 implementations.

`requiresPro(fn, feature, manager?)` preserves arguments, return type and `this`.
`requirePro(feature)` checks the package singleton. For isolated state, create
`new LicenseManager({ publicKeyHex, verifier: 'auto' })`; use its `setKey`,
`getInfo`, `requirePro` and `clear` methods. A manager with a different issuer
does not modify the package singleton's product gates. The default issuer is
the native **development** public key. Its test signing key is public in native
test history; it does not represent a production entitlement. Provision the
production issuer in a controlled distribution.

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

`encodePng(width, height, rgba, options)` and `Frame.toPng` remain available.
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

`loadImage`/`exportImage` share the exact PNG path. Other image types use
createImageBitmap and Canvas/OffscreenCanvas, with an HTMLImageElement/DOM
canvas fallback where needed. JPEG is lossy; Canvas display may premultiply
alpha. Always compare or retain the typed arrays for byte-level fidelity.

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

Operations are `renderer_rgba`, `scene_rgba`, `renderer_png`, `array_to_png`,
`png_to_array` and `custom`. Renderer operations take `target: session`, render
the caller's committed scene, and await readback/screenshot completion. They
record the session's actual typed W02 RendererConfig, capabilities, render
statistics and memory reports. They never create a preset catalog or dataset
registry. PNG fixtures are generated deterministically from the recorded seed;
fixture creation is outside timed samples. For `custom`, provide an operation
returning a value or a Promise and optionally a W02 `memory` report callback.
`runBenchmarkSuite` runs operations sequentially.

The versioned `BenchmarkResult` has `schemaVersion: 1`, operation, dimensions,
seed, warmup/iteration counts, raw `samplesMs`, `stats`, `throughput`, `renderer`,
`environment`, `memory`, `rendererStats` and `budget`. Stats include min, p50,
mean, p95, max and population standard deviation, with NumPy linear percentile
interpolation. Throughput is FPS and megapixels/second. Warmup and setup are
excluded. `timing: 'cpu-completion'` includes encoding/readback overhead and
must not be interpreted as GPU-only timing. Actual GPU timestamps, when
available, remain identified in the W02 `rendererStats` pass reports.

Environment records browser UA, concurrency, pixel ratio, secure/isolation
signals and the target's adapter/features/limits. Unavailable capabilities or
memory are `null`. Memory records before/after W02 reports, current-byte delta,
and the greatest observed current/lifetime peak allocation. Budget checks
report named violations for `maxP95Ms`/`maxMemoryBytes`; unavailable memory
cannot pass a memory budget. Cancellation and operation failures reject the
run. `maxDurationMs` defaults to five minutes and is checked between awaited
operations; it cannot preempt a Promise that the caller never resolves.

The original FND-07 viewer interaction/recovery benchmark remains its own
hardware evidence harness. These public per-operation reports extend the
benchmark tooling; they do not establish W00 physical-browser qualification.

See [W21 verification](w21-evidence.md) for native provenance and runnable gates.
