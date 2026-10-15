import { Forge3DError } from './index.js';
import { readByteSource } from './browser-io.js';
import { MemoryByteCache } from './byte-cache.js';
import { CODEC_CATALOG } from './codec-catalog.js';
import { codecFailure, dispatchCodec, normalizeCodecParameters } from './codec-dispatch.js';
import { CODEC_CACHE_PREFIX, codecDigest, packCodecArtifact, unpackCodecArtifact } from './codec-cache.js';
import { dispatchCodecDenoiser, selectCodecDenoiser } from './codec-denoiser.js';
import type { CodecDenoiseTarget, CodecDenoiseOptions, CodecDenoiserSelection } from './codec-denoiser.js';
import type { HdrFrame, AovFrame } from './frames.js';
import type { CodecFormat, CodecDecodeOptions, CodecReplayOptions, CodecRegistryOptions, CodecRegistryStats, CodecResult, CodecSelection, CodecSource } from './codec-types.js';

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw codecFailure('INVALID_INPUT', 'invalid-registry-limit', `${name} must be a positive safe integer`);
  return value;
}
/** Integrated E05 dispatch. No platform adapter or feature decoder is replaced. */
export class CodecRegistry {
  readonly #inputLimit: number;
  readonly #outputLimit: number;
  readonly #concurrency: number;
  readonly #cache: MemoryByteCache;
  readonly #store: CodecRegistryOptions['store'];
  readonly #disabled: Set<string>;
  readonly #jobs = new Map<AbortController, Promise<unknown>>();
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(options: CodecRegistryOptions = {}) {
    this.#inputLimit = positive(options.maxInputBytes ?? 64 * 1024 * 1024, 'maxInputBytes');
    this.#outputLimit = positive(options.maxDecodedBytes ?? 256 * 1024 * 1024, 'maxDecodedBytes');
    this.#concurrency = positive(options.maxConcurrent ?? 2, 'maxConcurrent');
    this.#cache = new MemoryByteCache(positive(options.cacheBytes ?? 16 * 1024 * 1024, 'cacheBytes'));
    this.#store = options.store;
    this.#disabled = new Set(options.disabled ?? []);
    if ([...this.#disabled].some(f => !CODEC_CATALOG.some(c => c.format === f))) throw codecFailure('INVALID_INPUT', 'codec-not-registered', 'disabled contains an unknown codec');
  }

  capabilities(): readonly CodecSelection[] { this.#assertLive(); return CODEC_CATALOG.map(c => this.select(c.format)); }
  select(format: string): CodecSelection {
    this.#assertLive();
    const codec = CODEC_CATALOG.find(c => c.format === format);
    let reason: Extract<CodecSelection, {status: 'unavailable'}>['reason'] | undefined;
    if (!codec) reason = 'codec-not-registered';
    else if (this.#disabled.has(format)) reason = 'codec-disabled';
    else if (['exr','laz'].includes(format) && typeof WebAssembly === 'undefined') reason = 'webassembly-unavailable';
    else if (format === 'laz' && (typeof Worker !== 'function' || typeof MessageChannel !== 'function')) reason = 'worker-hard-stop-unavailable';
    if (reason) return { status: 'unavailable', format, code: 'UNSUPPORTED_FEATURE', reason };
    // Copy nested metadata so callers cannot change selection or cache identity.
    return { status: 'selected', codec: structuredClone(codec!) };
  }

  decode<F extends CodecFormat>(format: F, source: CodecSource, options: CodecDecodeOptions = {}): Promise<CodecResult<F>> {
    return this.#run(options.signal, async signal => {
      const codec = this.#require(format);
      const parameters = normalizeCodecParameters(format, options.parameters);
      const maxBytes = Math.min(this.#inputLimit, positive(options.maxBytes ?? this.#inputLimit, 'maxBytes'));
      const knownSize = source instanceof ArrayBuffer || ArrayBuffer.isView(source) ? source.byteLength : typeof Blob !== 'undefined' && source instanceof Blob ? source.size : undefined;
      if (knownSize !== undefined && knownSize > maxBytes) throw codecFailure('RESOURCE_LIMIT_EXCEEDED', 'input-byte-limit', 'Codec input exceeds the encoded byte limit', format);
      const bytes = await readByteSource(source, { maxBytes, signal, ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
      this.#check(signal);
      const artifact = packCodecArtifact(codec, parameters, bytes);
      const cacheKey = CODEC_CACHE_PREFIX + await codecDigest(artifact);
      const value = await this.#dispatch(format, bytes, parameters, signal);
      this.#check(signal);
      // Persist only successful inputs; byte artifacts replay through the feature decoder.
      if (this.#store) await this.#storage(() => this.#store!.put(cacheKey, artifact.slice()));
      this.#check(signal);
      this.#cache.put(cacheKey, artifact);
      return { codec, value, cacheKey };
    });
  }

  replay<F extends CodecFormat>(key: string, options: CodecReplayOptions<F>): Promise<CodecResult<F>>;
  replay(key: string, options?: Pick<CodecDecodeOptions, 'signal'>): Promise<CodecResult>;
  replay(key: string, options: Pick<CodecDecodeOptions, 'signal'> & { format?: CodecFormat } = {}): Promise<CodecResult> {
    return this.#run(options.signal, async signal => {
      if (!/^forge3d-codec-v1\/[a-f0-9]{64}$/.test(key)) throw codecFailure('INVALID_INPUT', 'invalid-cache-key', 'Invalid codec cache key');
      let artifact = this.#cache.get(key);
      if (!artifact && this.#store) artifact = await this.#storage(() => this.#store!.get(key));
      this.#check(signal);
      if (!artifact) throw codecFailure('IO_ERROR', 'cache-miss', 'Codec artifact is absent');
      if (!(artifact instanceof Uint8Array) || artifact.length > this.#inputLimit + 4100) throw codecFailure('IO_ERROR', 'cache-corrupt', 'Cached artifact exceeds the bounded framing size');
      artifact = artifact.slice();
      const { header, bytes } = await unpackCodecArtifact(key, artifact, this.#inputLimit);
      if (options.format !== undefined && options.format !== header.format) throw codecFailure('INVALID_INPUT', 'cache-format-mismatch', 'Cached format does not match the requested result type', header.format);
      const codec = this.#require(header.format);
      if (header.revision !== codec.revision) throw codecFailure('UNSUPPORTED_FEATURE', 'cache-incompatible', 'Codec implementation changed; decode the source again', header.format);
      const parameters = normalizeCodecParameters(header.format, header.parameters);
      const value = await this.#dispatch(header.format, bytes, parameters, signal);
      this.#check(signal);
      this.#cache.put(key, artifact);
      return { codec, value, cacheKey: key };
    });
  }

  denoiserCapability(target?: CodecDenoiseTarget, method: 'atrous' | 'oidn' = 'atrous'): CodecDenoiserSelection {
    this.#assertLive(); return selectCodecDenoiser(target, method);
  }
  denoise(target: CodecDenoiseTarget, frame: HdrFrame, guides: AovFrame, options: CodecDenoiseOptions = {}): Promise<HdrFrame> {
    return this.#run(options.signal, async signal => {
      const selection = selectCodecDenoiser(target, options.settings?.method === 'oidn' ? 'oidn' : 'atrous');
      if (selection.status === 'unavailable') throw codecFailure(selection.code, selection.reason, 'A W06 GPU denoise target is required');
      const result = await dispatchCodecDenoiser(target, frame, guides, options, this.#outputLimit);
      this.#check(signal); return result;
    });
  }
  stats(): CodecRegistryStats {
    const c = this.#cache.stats();
    return { disposed: this.#disposed, activeOperations: this.#jobs.size, cacheBytes: c.bytes, cacheEntries: c.entries, cacheHits: c.hits, cacheMisses: c.misses };
  }
  /** Aborts IO/workers, drains submitted GPU work, and releases owned cache memory. */
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    for (const controller of this.#jobs.keys()) controller.abort();
    this.#cache.clear();
    this.#disposal = Promise.allSettled([...this.#jobs.values()]).then(() => { this.#cache.clear(); });
    return this.#disposal;
  }
  #assertLive(): void { if (this.#disposed) throw codecFailure('RUNTIME_DISPOSED', 'registry-disposed', 'Codec registry is disposed'); }
  async #storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof Forge3DError) throw error;
      throw codecFailure('IO_ERROR', 'cache-store-failed', `Codec cache store failed: ${String(error)}`);
    }
  }
  #check(signal: AbortSignal): void {
    this.#assertLive();
    if (signal.aborted) throw codecFailure('REQUEST_CANCELLED', 'aborted', 'Codec operation was cancelled');
  }
  #require(format: string) {
    const selection = this.select(format);
    if (selection.status === 'unavailable') throw codecFailure(selection.code, selection.reason, `Codec ${format} is unavailable`, format);
    return selection.codec;
  }
  async #dispatch<F extends CodecFormat>(format: F, bytes: Uint8Array, parameters: import('./codec-types.js').CodecParameters, signal: AbortSignal) {
    try { return await dispatchCodec(format, bytes, parameters, this.#outputLimit, signal); }
    catch (error) {
      this.#check(signal);
      const cause = Forge3DError.from(error);
      // Keep lifecycle and feature-limit codes; normalize parser IO failures.
      const typed = error instanceof Forge3DError;
      const code = typed && cause.code !== 'IO_ERROR' ? cause.code : 'INVALID_INPUT';
      const details = cause.details as { reason?: string } | undefined;
      throw codecFailure(code, details?.reason ?? (code === 'UNSUPPORTED_FEATURE' ? 'codec-capability-unavailable' : code === 'RESOURCE_LIMIT_EXCEEDED' ? 'decoded-byte-limit' : 'corrupt-input'), cause.message, format);
    }
  }
  #run<T>(external: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try { this.#assertLive(); } catch (error) { return Promise.reject(error); }
    if (this.#jobs.size >= this.#concurrency) return Promise.reject(codecFailure('RESOURCE_LIMIT_EXCEEDED', 'codec-backpressure', 'Codec operation limit reached'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) controller.abort();
    const job = Promise.resolve().then(() => { this.#check(controller.signal); return operation(controller.signal); }).catch(error => { this.#check(controller.signal); throw error; }).finally(() => {
      external?.removeEventListener('abort', abort);
      this.#jobs.delete(controller);
    });
    this.#jobs.set(controller, job);
    return job;
  }
}
