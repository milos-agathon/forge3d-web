import { SceneState } from './scene-review.js';
import type { SceneRecipeInput } from './map-scene-types.js';
type RecordValue = Record<string, any>;
/** Native directories can be zipped without altering their checked payloads. Unknown native intent is preserved and diagnosed. */
export declare function migrateNativeBundle(manifest: RecordValue, files: Record<string, Uint8Array>, baseRecipe?: SceneRecipeInput): SceneState;
export {};
