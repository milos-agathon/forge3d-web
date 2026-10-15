# Codec registry and denoising

`CodecRegistry` integrates the feature-owned TIFF/COG, LAZ, KTX2/Basis,
Radiance HDR, EXR, self-contained GLB and glyph-PBF decoders. The registry
does not replace W02 storage, workers or platform adapters. Codec descriptions
include their feature owner, exact dependency versions and SHA-256 pins from
the W00 dependency lock. Build-time fingerprints cover the delegated code.

```ts
import { CodecRegistry, CacheStorageByteCache } from '@forge3d/web';

const registry = new CodecRegistry({
  store: new CacheStorageByteCache({ name: 'my-codecs' }),
  maxInputBytes: 64 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
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
operations to two. Excess concurrent work reports `RESOURCE_LIMIT_EXCEEDED`
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
`REQUEST_CANCELLED`. Caller-owned runtimes and persistent stores remain usable.

The [example](../examples/codecs.html),
[fixture manifest](../tests/fixtures/w22/manifest.json), and
[verification record](w22-evidence.md) cover source and installed-package use.
