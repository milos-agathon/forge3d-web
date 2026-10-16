# Codec registry and denoising

`CodecRegistry` integrates the feature-owned TIFF/COG, LAZ, KTX2/Basis,
Radiance HDR, EXR, self-contained GLB and glyph-PBF decoders. The registry
does not replace W02 storage, workers or platform adapters. Codec descriptions
include their feature owner, exact dependency versions and SHA-256 pins from
the W00 dependency lock. Build-time fingerprints conservatively cover all TS/Rust runtime sources, workers, shaders, binding helpers, build scripts and dependency/toolchain locks. An unrelated implementation change may also invalidate replay.

```ts
import { CodecRegistry, CacheStorageByteCache } from '@forge3d/web';

const registry = new CodecRegistry({
  store: new CacheStorageByteCache({ name: 'my-codecs' }),
  maxInputBytes: 64 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxWorkingBytes: 640 * 1024 * 1024,
  persistentCacheBytes: 64 * 1024 * 1024,
});
try {
  const capability = registry.select('hdr');
  if (capability.status === 'selected') {
    const result = await registry.decode('hdr', '/environment.hdr');
    const restored = await registry.replay(result.cacheKey);
    console.log(result.codec, restored.value);
  }
} finally {
  await registry.dispose();
}
```

Sources use the existing async browser IO contract: URL, File/Blob,
ArrayBuffer/view, Response or readable byte stream. Input and decoded limits
default to 64 MiB and 256 MiB, retained memory cache to 16 MiB and concurrent
operations to two. `maxWorkingBytes` defaults to 640 MiB and admits a conservative
transient reservation before IO: four encoded-input copies plus framing and the
decoded-output limit (unknown source sizes reserve the input limit). Replay
reserves three input copies plus framing/output; denoise reserves 68 bytes/pixel.
These reservations cover registry copies and one store copy, and are observable
in `workingBytes`/`peakWorkingBytes`. Retained cache bytes, feature-owned WASM/
worker scratch space and W06's separate GPU ledger have their own accounting;
this is not a process-wide heap limit. Admission failure reports
`RESOURCE_LIMIT_EXCEEDED/working-byte-limit`. Excess concurrent work reports `RESOURCE_LIMIT_EXCEEDED`
with reason `codec-backpressure`. TIFF returns band zero at the selected
`parameters.overview`; large, streamed datasets should use W08 `CogDataset`
directly. KTX2 accepts `parameters.semantic` and `parameters.capabilities`
(`bc`, `etc2`, `astc`); the default requests the RGBA8 fallback. GLB replay
requires a self-contained asset. W15 `loadGltf` owns external URI resolution.

`select` and `capabilities` select one installed decoder per format or return
`{status:'unavailable', code:'UNSUPPORTED_FEATURE', reason, format}`. Exact
selection reasons are `codec-not-registered`, `codec-disabled`,
`webassembly-unavailable`, and `worker-hard-stop-unavailable`. LAZ uses the
W16 owned worker and admission controller. Loading a selected codec can still
fail with a typed WASM, IO, capability or input error. Corrupt container errors
carry `details.scope = 'codec'` and a reason; failures never enter the cache.

Cache artifacts retain **encoded source bytes**, their normalized output
parameters and implementation fingerprint. Replay decodes these bytes again,
so it preserves float/channel data exactly and never fetches the original URL.
Keys hash the complete artifact; they change with bytes, output parameters,
dependency pins or implementation. Corruption returns `IO_ERROR/cache-corrupt`,
an absent artifact `IO_ERROR/cache-miss`, and stale implementation
`UNSUPPORTED_FEATURE/cache-incompatible`. Browser-managed WASM compilation and
driver pipeline caches remain browser-owned. Compiled GPU objects are never
serialized. The injected W02 store is application-owned and survives registry
disposal; the registry's bounded memory cache is released.

The managed persistent namespace has an LRU index and a default 64 MiB
`persistentCacheBytes` budget including artifact/index payloads (maximum 128
entries). Platform adapter framing/metadata is outside that logical byte budget.
Eviction precedes writes, and failed index commits roll back the new artifact.
Corrupt/stale artifacts are deleted on replay rejection. Oversized artifacts
remain eligible for the memory cache but are not persisted. Registry instances
sharing the same store object serialize index changes. Applications must use a
dedicated namespace and coordinate separate store objects/tabs themselves.
Legacy entries are adopted on access; clear pre-index namespaces when migrating
if they contain untracked entries. A corrupt index reports
`IO_ERROR/cache-index-corrupt` and requires an application namespace clear;
the minimal W02 store interface cannot enumerate unidentified entries.
Persistent stats describe the last managed operation, not live cross-owner usage.

## AOV-guided WebGPU denoise

```ts
const output = await registry.denoise(session, hdrFrame, aovFrame, {
  settings: { method: 'oidn', guides: { albedo: true, normal: true, depth: true } },
  signal,
});
```

The target is a W06 `Forge3DRuntime` or `Forge3DSession`. The registry delegates
to its existing WebGPU A-trous shader; `denoiserCapability(target, 'oidn')`
reports `id:'webgpu-atrous', equivalent:true`. This is the measurable browser
equivalent of optional native OIDN, with its own implementation fingerprint.
No OIDN binary is advertised. Every enabled guide must exist and match the HDR
dimensions. Missing guides return `INVALID_INPUT/missing-denoise-guide`.
W06 owns GPU allocation admission, readback, buffer release and device-loss
reporting; W02/W06 own runtime replacement and recovery. Registry disposal
aborts IO/workers and waits for submitted denoise work to finish, then rejects
its result with `RUNTIME_DISPOSED`. AbortSignal cancellation returns
`REQUEST_CANCELLED` promptly to the caller and forwards the signal to W06.
Submitted GPU work cannot be preempted: the owned operation, memory reservation
and concurrency slot remain until readback drains. Disposal waits for that drain.
Caller-owned runtimes and persistent stores remain usable.

The [example](../examples/codecs.html),
repository fixture manifest (`tests/fixtures/w22/manifest.json`), and
[verification record](w22-evidence.md) cover source and installed-package use.
