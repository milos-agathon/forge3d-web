import type { SceneStateInput } from './scene-review.js';
/** Opaque streamed-source intent still needs a support diagnostic in plain archives. */
export declare function assessBundleStyle(state: SceneStateInput): void;
/** The finite glyph inventory used by this scene, plus the sprite pair. */
export declare function styleAssetUrls(state: SceneStateInput, supplied: readonly string[]): string[];
