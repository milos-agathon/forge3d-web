import { requirePro, PRO_FEATURES } from './license.js';
import { Forge3DError, type BrowserByteSource, type BrowserByteSink } from './index.js';
import { readByteSource } from './browser-io.js';
import { styleAssetUrls, assessBundleStyle } from './bundle-style-assets.js';
import { writeBundleOutput } from './bundle-output.js';
import { SceneState, type SceneStateInput } from './scene-review.js';
import { SceneRecipe, encodeMapData, decodeMapData } from './map-recipe.js';
import { ValidationReport, type ValidationReportData } from './diagnostics.js';
import { missingExternalAssetDiagnostic } from './diagnostic-paths.js';
import { migrateNativeBundle } from './bundle-migration.js';
import type { SceneRecipeInput } from './map-scene-types.js';
import { bundledFontSources } from './typography.js';
import { bundleCancelled, bundleFailure, bundleHash, bundleLimits, bundlePath, decodeBundleArchive, encodeBundleArchive, type BundleLimits } from './bundle-archive.js';
export const BUNDLE_VERSION = 2;
export interface BundleManifest { version: number; name: string; created_at: string; description?: string; checksums: Record<string, string>; scene: string; media_types?: Record<string, string>; asset_aliases?: Record<string, string>; }
export interface BundleOptions extends BundleLimits { signal?: AbortSignal; /** Camera/output context when migrating zipped native directory bundles. */ nativeRecipe?: SceneRecipeInput; onProgress?: (progress: { phase: 'assets' | 'verify' | 'archive'; completed: number; total: number; path?: string }) => void; }
export interface SaveBundleOptions extends BundleOptions { name?: string; description?: string; createdAt?: string; sink?: BrowserByteSink; assets?: Record<string, Blob | Uint8Array>; /** Preserve missing URLs with blocking diagnostics; no success or offline render claim. */ allowMissingAssets?: boolean; }
const encoder = new TextEncoder(), marker = 'forge3d-asset:';
function parseJson(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return bundleFailure('Invalid bundle JSON'); } }
async function visitAssets(value: unknown, transform: (value: string, key: string, parent: Record<string, unknown>) => Promise<string>, key = '', parent: Record<string, unknown> = {}): Promise<unknown> {
    if (key === 'nativeSceneState') return value;
    if (key === 'sources' && value && typeof value === 'object') {
        const output: Record<string, unknown> = {};
        for (const [id, source] of Object.entries(value)) output[id] = source?.type === 'geojson' ? await visitAssets(source, transform) : structuredClone(source);
        return output;
    }
    if (typeof value === 'string') return transform(value, key, parent);
    if (ArrayBuffer.isView(value)) return value;
    if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await visitAssets(item, transform)); return out; }
    if (value && typeof value === 'object') { const output: Record<string, unknown> = {}; for (const k of Object.keys(value)) Object.defineProperty(output, k, { value: await visitAssets((value as Record<string, unknown>)[k], transform, k, value as Record<string, unknown>), enumerable: true, writable: true }); if (Object.hasOwn(value, 'sha256')) output.sha256 = (value as Record<string, unknown>).sha256; return output; }
    return value;
}
/** Self-contained glTF: rewrite subordinate buffers/images to data URIs before bundling. */
async function embedGltf(bytes: Uint8Array, base: string, options: BundleOptions, remaining: () => number): Promise<Uint8Array> {
    const data = parseJson(bytes) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    let used = 0;
    for (const resource of [...data.buffers ?? [], ...data.images ?? []]) if (resource.uri && !resource.uri.startsWith('data:')) {
        const payload = await readByteSource(new URL(resource.uri, base), { maxBytes: remaining() - used, ...(options.signal ? { signal: options.signal } : {}) }); used += payload.length;
        bundleCancelled(options.signal); let text = ''; for (let i = 0; i < payload.length; i += 8192) text += String.fromCharCode(...payload.subarray(i, i + 8192));
        resource.uri = `data:application/octet-stream;base64,${btoa(text)}`;
    }
    return encoder.encode(JSON.stringify(data));
}
/** Every payload, including canonical review state and diagnostics, is SHA-256 verified on load. */
export async function saveBundle(state: SceneState | SceneStateInput, options: SaveBundleOptions = {}): Promise<Blob> {
    requirePro(PRO_FEATURES.bundleSave);
    bundleCancelled(options.signal); const limits = bundleLimits(options), canonical = state instanceof SceneState ? state : new SceneState(state);
    const files: Record<string, Uint8Array> = Object.create(null), media: Record<string, string> = Object.create(null), aliases: Record<string, string> = Object.create(null), cache = new Map<string, { reference: string; originalHash: string; hash: string }>(); let size = 0;
    const add = async (data: Uint8Array, type: string) => {
        bundleCancelled(options.signal); const hash = await bundleHash(data), path = `assets/${hash}`;
        if (!Object.hasOwn(files, path)) { size += data.length; if (size > limits.maxExpandedBytes || Object.keys(files).length + 2 > limits.maxEntries) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle asset budget exceeded'); files[path] = data; media[path] = type; }
        return marker + path;
    };
    const remaining = () => limits.maxExpandedBytes - size;
    const supplied = Object.entries(options.assets ?? {});
    for (const [i, [name, source]] of supplied.entries()) {
        const data = source instanceof Uint8Array ? Uint8Array.from(source) : await readByteSource(source, { maxBytes: remaining(), ...(options.signal ? { signal: options.signal } : {}) });
        const reference = await add(data, source instanceof Blob ? source.type : 'application/octet-stream'); if (!name.startsWith(marker) && !name.startsWith('blob:')) aliases[name] = reference.slice(marker.length);
        const hash = await bundleHash(data); cache.set(name, { reference, hash, originalHash: hash }); options.onProgress?.({ phase: 'assets', completed: i + 1, total: supplied.length, path: name });
    }
    const portable = canonical.value; assessBundleStyle(portable);
    if (!portable.fonts && [...portable.base.layers ?? [], ...portable.reviewLayers?.flatMap(l => [...l.layers]) ?? []].some(l => l.kind === 'labels')) {
        const fonts: NonNullable<SceneStateInput['fonts']>[number][] = []; let fontBytes = 0;
        for (const source of bundledFontSources()) {
            const data = await readByteSource(source.url!, { maxBytes: remaining() - fontBytes, ...(options.signal ? { signal: options.signal } : {}) }); fontBytes += data.length;
            if (await bundleHash(data) !== source.sha256) bundleFailure('Bundled font digest mismatch', 'checksum-mismatch');
            fonts.push({ id: source.id, data, sha256: source.sha256! });
        }
        portable.fonts = fonts;
    }
    const missing = new Set(portable.missingAssets ?? []);
    const assetTransform = async (value: string, key: string, parent: Record<string, unknown>) => {
        const explicit = Object.hasOwn(options.assets ?? {}, value), external = (['url', 'hdr', 'hdrPath', 'hdr_path'].includes(key) || key === 'data' && parent.type === 'geojson') && !value.startsWith(marker);
        if (!explicit && !external) return value;
        if (cache.has(value)) { const cached = cache.get(value)!; if (typeof parent.sha256 === 'string' && cached.originalHash !== parent.sha256.toLowerCase()) bundleFailure(`Asset checksum mismatch: ${value}`, 'checksum-mismatch'); if (parent.sha256 !== undefined) parent.sha256 = cached.hash; return cached.reference; }
        options.onProgress?.({ phase: 'assets', completed: cache.size, total: cache.size + 1, path: value });
        const source = options.assets?.[value] ?? value;
        let data: Uint8Array;
        try { data = source instanceof Uint8Array ? Uint8Array.from(source) : await readByteSource(source, { maxBytes: remaining(), ...(options.signal ? { signal: options.signal } : {}) }); }
        catch (e) { bundleCancelled(options.signal); if (!options.allowMissingAssets || e instanceof Forge3DError && e.code === 'RESOURCE_LIMIT_EXCEEDED') throw e; missing.add(value); return value; }
        const originalHash = await bundleHash(data);
        if (typeof parent.sha256 === 'string' && originalHash !== parent.sha256.toLowerCase()) bundleFailure(`Asset checksum mismatch: ${value}`, 'checksum-mismatch');
        if (parent.format === 'gltf') {
            data = await embedGltf(data, value, options, remaining);
            // The bundled glTF now contains its dependencies. Hash the rewritten bytes.
            if (parent.sha256 !== undefined) parent.sha256 = await bundleHash(data);
        }
        const result = await add(data, source instanceof Blob ? source.type || 'application/octet-stream' : 'application/octet-stream'), hash = await bundleHash(data); cache.set(value, { reference: result, originalHash, hash }); aliases[value] = result.slice(marker.length); missing.delete(value); return result;
    };
    for (const url of styleAssetUrls(portable, Object.keys(options.assets ?? {}))) {
        if (url.includes('{range}') || url.includes('{fontstack}')) { if (!options.allowMissingAssets) bundleFailure('Glyph template needs a finite text/font request or supplied glyph inventory'); missing.add(url); continue; }
        await assetTransform(url, 'url', {});
    }
    const rewritten = await visitAssets(portable, assetTransform) as SceneStateInput;
    if (missing.size) {
        rewritten.missingAssets = [...missing].sort();
        const report = new ValidationReport({ ...(rewritten.validationReport ?? {}), diagnostics: [...rewritten.validationReport?.diagnostics ?? [], ...[...missing].sort().filter(path => !rewritten.validationReport?.diagnostics.some(d => d.code === 'missing_external_asset' && d.details.path === path && ['error', 'fatal'].includes(d.severity))).map(path => missingExternalAssetDiagnostic('bundle asset', path))] });
        rewritten.validationReport = report.toJSON();
        rewritten.reviewRecord = { renderable: false, render_status: 'blocked_by_diagnostics', last_render: null };
    }
    files['scene/state.json'] = encoder.encode(JSON.stringify(encodeMapData({ schema: 'forge3d.scene-state.v2', state: rewritten }, limits.maxExpandedBytes)));
    const checksums: Record<string, string> = Object.create(null);
    for (const [path, bytes] of Object.entries(files)) { bundleCancelled(options.signal); checksums[path] = await bundleHash(bytes); }
    const created_at = options.createdAt ?? new Date().toISOString(); if (!Number.isFinite(Date.parse(created_at))) throw new Forge3DError('INVALID_INPUT', 'Invalid bundle creation timestamp');
    const manifest: BundleManifest = { version: BUNDLE_VERSION, name: options.name ?? 'Forge3D scene', created_at, checksums, scene: 'scene/state.json', media_types: media, asset_aliases: aliases, ...(options.description !== undefined ? { description: options.description } : {}) };
    files['manifest.json'] = encoder.encode(JSON.stringify(manifest));
    bundleCancelled(options.signal); options.onProgress?.({ phase: 'archive', completed: 0, total: 1 });
    const bytes = encodeBundleArchive(files, options), blob = new Blob([bytes.slice().buffer], { type: 'application/vnd.forge3d+zip' });
    bundleCancelled(options.signal);
    if (options.sink) await writeBundleOutput(bytes, options.sink, options.signal);
    bundleCancelled(options.signal); options.onProgress?.({ phase: 'archive', completed: 1, total: 1 }); return blob;
}
export class LoadedBundle {
    readonly #manifest: BundleManifest;
    #state: SceneState;
    #files: Record<string, Uint8Array>;
    #urls = new Map<string, string>();
    #disposed = false;
    #lifetime = new AbortController();
    readonly migratedFrom: number | null;
    constructor(manifest: BundleManifest, state: SceneState, files: Record<string, Uint8Array>, migratedFrom: number | null) { this.#manifest = structuredClone(manifest); this.#state = state; this.#files = files; this.migratedFrom = migratedFrom; }
    #live() { if (this.#disposed) throw new Forge3DError('RUNTIME_DISPOSED', 'Bundle is disposed'); }
    get manifest(): BundleManifest { this.#live(); return structuredClone(this.#manifest); }
    get sceneState(): SceneState { this.#live(); return new SceneState(this.#state.value); }
    listVariants() { this.#live(); return this.#state.listVariants(); }
    listReviewLayers() { this.#live(); return this.#state.listReviewLayers(); }
    getActiveVariantId() { this.#live(); return this.#state.activeVariantId; }
    applyVariant(id: string): void { this.#live(); this.#state = this.#state.applyVariant(id); }
    setReviewLayerVisible(id: string, visible: boolean): void { this.#live(); this.#state = this.#state.setReviewLayerVisible(id, visible); }
    effectiveSceneState() { this.#live(); return this.#state.effectiveRecipe(); }
    get validationReport(): ValidationReport | null { this.#live(); const report = this.#state.value.validationReport; return report ? ValidationReport.fromJSON(report) : null; }
    asset(path: string): Uint8Array { this.#live(); const bytes = this.#files[bundlePath(path)]; if (!bytes) bundleFailure(`Missing bundle asset: ${path}`); return bytes.slice(); }
    resolveAsset(url: string): string {
        this.#live(); const path = this.#manifest.asset_aliases?.[url]; if (!path || !Object.hasOwn(this.#files, path)) bundleFailure(`Asset is absent from offline bundle: ${url}`);
        let lease = this.#urls.get(path); if (!lease) { lease = URL.createObjectURL(new Blob([this.#files[path]!.slice().buffer], { type: this.#manifest.media_types?.[path] ?? 'application/octet-stream' })); this.#urls.set(path, lease); } return lease;
    }
    getMemoryReport() { return { cpuBytes: Object.values(this.#files).reduce((n, v) => n + v.byteLength, 0) + (this.#disposed ? 0 : this.#state.getMemoryReport().cpuBytes) + [...this.#urls.keys()].reduce((n, p) => n + this.#files[p]!.byteLength, 0), assetCount: Object.keys(this.#files).length, objectUrlCount: this.#urls.size, disposed: this.#disposed }; }
    /** URL leases belong to this bundle and are revoked by dispose. MapScene.loadBundle adopts that lifetime. */
    async runtimeSceneState(): Promise<SceneState> {
        this.#live();
        const input = await visitAssets(this.#state.value, async value => {
            this.#live();
            if (!value.startsWith(marker)) return value;
            const path = bundlePath(value.slice(marker.length));
            if (!Object.hasOwn(this.#files, path)) bundleFailure(`Missing referenced asset: ${path}`);
            let url = this.#urls.get(path);
            if (!url) { url = URL.createObjectURL(new Blob([this.#files[path]!.slice().buffer], { type: this.#manifest.media_types?.[path] ?? 'application/octet-stream' })); this.#urls.set(path, url); }
            return url;
        }) as SceneStateInput;
        this.#live(); return new SceneState(input);
    }
    /** Defensive payload copies used when a MapScene adopts and re-saves this archive. */
    retainedAssets(): Record<string, Uint8Array> {
        this.#live(); const assets: Record<string, Uint8Array> = Object.create(null);
        for (const [path, bytes] of Object.entries(this.#files)) if (path !== 'manifest.json' && path !== this.#manifest.scene && !['scene/state.json', 'scene/recipe.json'].includes(path)) assets[marker + path] = bytes.slice();
        for (const [alias, path] of Object.entries(this.#manifest.asset_aliases ?? {})) assets[alias] = this.#files[path]!.slice();
        for (const [path, url] of this.#urls) assets[url] = this.#files[path]!.slice();
        return assets;
    }
    async save(options: SaveBundleOptions = {}): Promise<Blob> {
        this.#live(); const assets = this.retainedAssets();
        const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
        return saveBundle(this.#state, { name: this.#manifest.name, allowMissingAssets: !!this.#state.value.missingAssets?.length, ...options, signal, assets: { ...assets, ...options.assets } });
    }
    dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#lifetime.abort(); for (const url of this.#urls.values()) URL.revokeObjectURL(url); this.#urls.clear(); this.#files = Object.create(null); this.#state = undefined!; }
}
export async function isBundle(source: BrowserByteSource | FileSystemFileHandle, options: BundleOptions = {}): Promise<boolean> {
    try { const loaded = await loadBundle(source, options); loaded.dispose(); return true; } catch (e) { if (e instanceof Forge3DError && e.code === 'REQUEST_CANCELLED') throw e; return false; }
}
async function loadVerifiedBundle(source: BrowserByteSource | FileSystemFileHandle, options: BundleOptions = {}): Promise<LoadedBundle> {
    const limits = bundleLimits(options); bundleCancelled(options.signal);
    if ((source instanceof ArrayBuffer || ArrayBuffer.isView(source)) && source.byteLength > limits.maxBytes || source instanceof Blob && source.size > limits.maxBytes) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle exceeds compressed byte limit');
    const bytes = await readByteSource(typeof source === 'object' && 'getFile' in source ? await source.getFile() : source, { maxBytes: limits.maxBytes, ...(options.signal ? { signal: options.signal } : {}) });
    const files = decodeBundleArchive(bytes, options, options.signal);
    if (!files['manifest.json']) bundleFailure('Bundle manifest missing');
    const manifest = parseJson(files['manifest.json']) as BundleManifest;
    if (!manifest || typeof manifest !== 'object' || ![1, BUNDLE_VERSION].includes(manifest.version)) bundleFailure('Unsupported bundle version', 'bundle-version-mismatch');
    if (typeof manifest.name !== 'string' || !manifest.checksums || typeof manifest.checksums !== 'object' || Array.isArray(manifest.checksums)) bundleFailure('Invalid bundle manifest');
    const paths = Object.keys(files).filter(p => p !== 'manifest.json');
    if (Object.keys(manifest.checksums).length !== paths.length || Object.hasOwn(manifest.checksums, 'manifest.json')) bundleFailure('Every payload must have a checksum');
    for (const [i, path] of paths.entries()) {
        bundleCancelled(options.signal);
        const expected = manifest.checksums[path];
        if (!Object.hasOwn(manifest.checksums, path) || !/^[a-f0-9]{64}$/.test(expected ?? '') || await bundleHash(files[path]!) !== expected) bundleFailure(`Checksum mismatch: ${path}`, 'checksum-mismatch');
        options.onProgress?.({ phase: 'verify', completed: i + 1, total: paths.length, path });
    }
    for (const path of Object.values(manifest.asset_aliases ?? {})) if (typeof path !== 'string' || !Object.hasOwn(files, bundlePath(path))) bundleFailure('Invalid bundle asset alias');
    let state: SceneState;
    if (manifest.scene === undefined && !files['scene/recipe.json']) {
        state = migrateNativeBundle(manifest, files, options.nativeRecipe);
        manifest.asset_aliases = { ...manifest.asset_aliases, ...Object.fromEntries(paths.filter(p => p.startsWith('assets/')).map(p => [p, p])) };
    } else if (manifest.version === 1) {
        const path = bundlePath(manifest.scene ?? 'scene/recipe.json'); if (!files[path]) bundleFailure('Legacy recipe missing');
        state = new SceneState({ base: SceneRecipe.fromJSON(parseJson(files[path]!)).value });
    } else { const path = bundlePath(manifest.scene); if (!files[path]) bundleFailure('Canonical scene state missing'); state = SceneState.fromJSON(parseJson(files[path]!), limits.maxExpandedBytes); }
    const assessed = state.value; assessBundleStyle(assessed); state = new SceneState(assessed);
    if (state.value.validationReport) ValidationReport.fromJSON(state.value.validationReport);
    // Reject dangling asset references and raw external URLs: a loaded bundle is offline by construction.
    await visitAssets(state.value, async (value, key, parent) => {
        if (value.startsWith(marker) && !Object.hasOwn(files, bundlePath(value.slice(marker.length)))) bundleFailure('Dangling bundle asset reference');
        if ((['url', 'hdr', 'hdrPath', 'hdr_path'].includes(key) || key === 'data' && parent.type === 'geojson') && !value.startsWith(marker)) {
            const s = state.value;
            if (!s.missingAssets?.includes(value) || !s.validationReport?.diagnostics.some(d => d.code === 'missing_external_asset' && d.details.path === value && ['error', 'fatal'].includes(d.severity))) bundleFailure('External asset reference without blocking missing-asset diagnostics');
        }
        return value;
    });
    for (const url of styleAssetUrls(state.value, Object.keys(manifest.asset_aliases ?? {}))) {
        if (manifest.asset_aliases?.[url]) continue;
        if (!state.value.missingAssets?.includes(url) || !state.value.validationReport?.diagnostics.some(d => d.code === 'missing_external_asset' && d.details.path === url && ['error', 'fatal'].includes(d.severity))) bundleFailure('Style asset without offline payload or blocking diagnostics');
    }
    bundleCancelled(options.signal);
    return new LoadedBundle(manifest, state, files, manifest.version === 1 || state.value.nativeSceneState ? manifest.version : null);
}
export async function loadBundle(source: BrowserByteSource | FileSystemFileHandle, options: BundleOptions = {}): Promise<LoadedBundle> {
    requirePro(PRO_FEATURES.bundleLoad);
    try { return await loadVerifiedBundle(source, options); }
    catch (e) { bundleCancelled(options.signal); if (e instanceof Forge3DError) throw e; throw new Forge3DError('IO_ERROR', `Invalid bundle: ${String(e)}`, { reason: 'invalid-bundle' }); }
}
