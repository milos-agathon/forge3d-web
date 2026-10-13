import { type BrowserByteSource, type BrowserByteSink } from './index.js';
import { SceneState, type SceneStateInput } from './scene-review.js';
import { ValidationReport } from './diagnostics.js';
import type { SceneRecipeInput } from './map-scene-types.js';
import { type BundleLimits } from './bundle-archive.js';
export declare const BUNDLE_VERSION = 2;
export interface BundleManifest {
    version: number;
    name: string;
    created_at: string;
    description?: string;
    checksums: Record<string, string>;
    scene: string;
    media_types?: Record<string, string>;
    asset_aliases?: Record<string, string>;
}
export interface BundleOptions extends BundleLimits {
    signal?: AbortSignal; /** Camera/output context when migrating zipped native directory bundles. */
    nativeRecipe?: SceneRecipeInput;
    onProgress?: (progress: {
        phase: 'assets' | 'verify' | 'archive';
        completed: number;
        total: number;
        path?: string;
    }) => void;
}
export interface SaveBundleOptions extends BundleOptions {
    name?: string;
    description?: string;
    createdAt?: string;
    sink?: BrowserByteSink;
    assets?: Record<string, Blob | Uint8Array>; /** Preserve missing URLs with blocking diagnostics; no success or offline render claim. */
    allowMissingAssets?: boolean;
}
/** Every payload, including canonical review state and diagnostics, is SHA-256 verified on load. */
export declare function saveBundle(state: SceneState | SceneStateInput, options?: SaveBundleOptions): Promise<Blob>;
export declare class LoadedBundle {
    #private;
    readonly migratedFrom: number | null;
    constructor(manifest: BundleManifest, state: SceneState, files: Record<string, Uint8Array>, migratedFrom: number | null);
    get manifest(): BundleManifest;
    get sceneState(): SceneState;
    listVariants(): import("./scene-review.js").SceneVariant[];
    listReviewLayers(): import("./scene-review.js").ReviewLayer[];
    getActiveVariantId(): string | null;
    applyVariant(id: string): void;
    setReviewLayerVisible(id: string, visible: boolean): void;
    effectiveSceneState(): SceneRecipeInput;
    get validationReport(): ValidationReport | null;
    asset(path: string): Uint8Array;
    resolveAsset(url: string): string;
    getMemoryReport(): {
        cpuBytes: number;
        assetCount: number;
        objectUrlCount: number;
        disposed: boolean;
    };
    /** URL leases belong to this bundle and are revoked by dispose. MapScene.loadBundle adopts that lifetime. */
    runtimeSceneState(): Promise<SceneState>;
    /** Defensive payload copies used when a MapScene adopts and re-saves this archive. */
    retainedAssets(): Record<string, Uint8Array>;
    save(options?: SaveBundleOptions): Promise<Blob>;
    dispose(): void;
}
export declare function isBundle(source: BrowserByteSource | FileSystemFileHandle, options?: BundleOptions): Promise<boolean>;
export declare function loadBundle(source: BrowserByteSource | FileSystemFileHandle, options?: BundleOptions): Promise<LoadedBundle>;
