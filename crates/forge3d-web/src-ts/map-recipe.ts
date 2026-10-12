import { canonicalJson, RenderFailurePolicy, type JsonValue } from './diagnostics.js';
import type { SceneRecipeInput, TerrainSourceInput, RasterOverlayInput, VectorOverlayInput, MapSceneBuildingLayerInput, MapSceneLabelLayerInput, MapScenePointCloudLayerInput, MapSceneTiles3DLayerInput, OrbitCameraInput, LightingPresetInput, OutputSpecInput, ReproducibilityProfileInput } from './map-scene-types.js';
import type { CameraInput } from './index.js';
export const MAP_SCENE_RECIPE_SCHEMA = 'forge3d.mapscene.recipe.v1';
/** Browser serialization guard; explicit resource/recipe budgets may raise its default. */
export function mapRecipeByteLimit(input: SceneRecipeInput): number {
    const policy = input?.diagnosticsPolicy;
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
    if (valid(policy?.maxRecipeBytes)) return policy.maxRecipeBytes;
    const limits = [64 * 1024 * 1024, ...(valid(policy?.maxResourceBytes) ? [policy.maxResourceBytes] : [])];
    for (const source of [input?.terrain?.source, ...(input?.layers ?? []).map(l => l && 'source' in l ? l.source : undefined)]) if (valid(source?.maxBytes)) limits.push(source.maxBytes);
    return Math.max(...limits);
}
const arrays = { Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array };
type ArrayName = keyof typeof arrays;
export function encodeMapData(value: unknown, maxBytes = 64 * 1024 * 1024): JsonValue {
    const seen = new Set<object>();
    let bytes = 0, nodes = 0;
    const visit = (v: unknown): JsonValue => {
        if (++nodes > 1000000)
            throw new RangeError('Map recipe has too many values');
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
            const name = v.constructor.name as ArrayName;
            if (!(name in arrays))
                throw new TypeError('Unsupported map array');
            bytes += v.byteLength;
            if (bytes > maxBytes)
                throw new RangeError('Map recipe exceeds serialized byte limit');
            const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            let text = '';
            for (let i = 0; i < raw.length; i += 8192)
                text += String.fromCharCode(...raw.subarray(i, i + 8192));
            return { $forge3d_array: name, base64: btoa(text) };
        }
        if (v && typeof v === 'object') {
            if (seen.has(v))
                throw new TypeError('Cyclic map recipe');
            seen.add(v);
            try {
                if (Array.isArray(v))
                    return v.map(visit);
                if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
                    throw new TypeError('Map recipe requires plain data or typed arrays');
                if ('$forge3d_array' in v)
                    throw new TypeError('Reserved map array tag');
                return Object.fromEntries(Object.keys(v).sort().map(k => [k, visit((v as Record<string, unknown>)[k])]));
            }
            finally {
                seen.delete(v);
            }
        }
        if (typeof v === 'string')
            bytes += v.length * 2;
        if (bytes > maxBytes)
            throw new RangeError('Map recipe exceeds serialized byte limit');
        return canonicalJson(v);
    };
    return visit(value);
}
export function decodeMapData(value: unknown, maxBytes = 64 * 1024 * 1024): unknown {
    let bytes = 0, nodes = 0;
    const data = canonicalJson(value);
    const visit = (v: JsonValue): unknown => {
        if (++nodes > 1000000)
            throw new RangeError('Map recipe has too many values');
        if (Array.isArray(v))
            return v.map(visit);
        if (v && typeof v === 'object') {
            if ('$forge3d_array' in v) {
                const name = v.$forge3d_array;
                if (typeof name !== 'string' || !Object.hasOwn(arrays, name) || typeof v.base64 !== 'string' || Object.keys(v).length !== 2)
                    throw new TypeError('Invalid map array encoding');
                // Scan bounded chunks: a repeated whole-string regexp over a large DEM
                // can exhaust the JS regexp stack before the byte budget is checked.
                const padding = v.base64.endsWith('==') ? 2 : v.base64.endsWith('=') ? 1 : 0;
                const bodyLength = v.base64.length - padding;
                if (v.base64.length % 4 || (padding && bodyLength < 2))
                    throw new TypeError('Invalid map array base64');
                for (let i = 0; i < bodyLength; i += 8192)
                    if (/[^A-Za-z0-9+/]/.test(v.base64.slice(i, Math.min(i + 8192, bodyLength))))
                        throw new TypeError('Invalid map array base64');
                const length = Math.floor(v.base64.length * 3 / 4) - padding;
                bytes += length;
                if (bytes > maxBytes)
                    throw new RangeError('Map recipe exceeds serialized byte limit');
                const type = arrays[name as ArrayName];
                if (length % type.BYTES_PER_ELEMENT)
                    throw new TypeError('Invalid map array byte length');
                const raw = atob(v.base64), buffer = new Uint8Array(length);
                for (let i = 0; i < length; i++)
                    buffer[i] = raw.charCodeAt(i);
                return new type(buffer.buffer);
            }
            return Object.fromEntries(Object.keys(v).map(k => [k, visit(v[k]!)]));
        }
        if (typeof v === 'string')
            bytes += v.length * 2;
        if (bytes > maxBytes)
            throw new RangeError('Map recipe exceeds serialized byte limit');
        return v;
    };
    return visit(data);
}
export function mapCamera(input: CameraInput | OrbitCameraInput): CameraInput {
    if ('kind' in input && input.kind === 'orbit-camera') {
        const az = (input.azimuthDegrees ?? 0) * Math.PI / 180, el = (input.elevationDegrees ?? 45) * Math.PI / 180, d = input.distance;
        return { position: [input.target[0] + d * Math.sin(az) * Math.cos(el), input.target[1] + d * Math.sin(el), input.target[2] + d * Math.cos(az) * Math.cos(el)], target: [...input.target], up: [0, 1, 0], fovYDegrees: input.fovYDegrees ?? 45, near: input.near ?? 0.1, far: input.far ?? Math.max(10000, d * 10) };
    }
    return structuredClone(input as CameraInput);
}
export class TerrainSource implements TerrainSourceInput {
    readonly kind = 'terrain-source';
    readonly source: TerrainSourceInput['source'];
    declare requestedStats?: readonly string[];
    constructor(input: TerrainSourceInput) { this.source = structuredClone(input.source); if (input.requestedStats)
        this.requestedStats = [...input.requestedStats]; }
}
export class RasterOverlay implements RasterOverlayInput {
    readonly kind = 'raster';
    declare layerId: string;
    declare source: RasterOverlayInput['source'];
    constructor(input: Omit<RasterOverlayInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class VectorOverlay implements VectorOverlayInput {
    readonly kind = 'vector';
    declare layerId: string;
    declare source: VectorOverlayInput['source'];
    constructor(input: Omit<VectorOverlayInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class MapSceneBuildingLayer implements MapSceneBuildingLayerInput {
    readonly kind = 'buildings';
    declare layerId: string;
    declare source: MapSceneBuildingLayerInput['source'];
    constructor(input: Omit<MapSceneBuildingLayerInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class MapSceneLabelLayer implements MapSceneLabelLayerInput {
    readonly kind = 'labels';
    declare layerId: string;
    declare source: MapSceneLabelLayerInput['source'];
    constructor(input: Omit<MapSceneLabelLayerInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class MapScenePointCloudLayer implements MapScenePointCloudLayerInput {
    readonly kind = 'point-cloud';
    declare layerId: string;
    declare source: MapScenePointCloudLayerInput['source'];
    constructor(input: Omit<MapScenePointCloudLayerInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class MapSceneTiles3DLayer implements MapSceneTiles3DLayerInput {
    readonly kind = 'tiles3d';
    declare layerId: string;
    declare source: MapSceneTiles3DLayerInput['source'];
    constructor(input: Omit<MapSceneTiles3DLayerInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class OrbitCamera implements OrbitCameraInput {
    readonly kind = 'orbit-camera';
    declare target: [
        number,
        number,
        number
    ];
    declare distance: number;
    constructor(input: Omit<OrbitCameraInput, 'kind'>) { Object.assign(this, structuredClone(input)); }
}
export class LightingPreset implements LightingPresetInput {
    declare name: 'default' | 'daylight' | 'overcast' | 'sunset';
    constructor(input: LightingPresetInput = {}) { Object.assign(this, { name: 'default', ...structuredClone(input) }); }
}
export class OutputSpec implements OutputSpecInput {
    declare width: number;
    declare height: number;
    readonly format = 'png';
    constructor(input: OutputSpecInput) { Object.assign(this, structuredClone(input)); }
}
export class ReproducibilityProfile implements ReproducibilityProfileInput {
    declare seed: number;
    constructor(input: ReproducibilityProfileInput = {}) { Object.assign(this, { seed: 0, ...structuredClone(input) }); }
}
export interface RasterOverlay extends RasterOverlayInput {
}
export interface VectorOverlay extends VectorOverlayInput {
}
export interface MapSceneBuildingLayer extends MapSceneBuildingLayerInput {
}
export interface MapSceneLabelLayer extends MapSceneLabelLayerInput {
}
export interface MapScenePointCloudLayer extends MapScenePointCloudLayerInput {
}
export interface MapSceneTiles3DLayer extends MapSceneTiles3DLayerInput {
}
export interface OrbitCamera extends OrbitCameraInput {
}
export interface LightingPreset extends LightingPresetInput {
}
export interface ReproducibilityProfile extends ReproducibilityProfileInput {
}
export class SceneRecipe {
    readonly #input: SceneRecipeInput;
    constructor(input: SceneRecipeInput) {
        this.#input = structuredClone(input);
        this.#input.renderPolicy = RenderFailurePolicy.validate(input.renderPolicy ?? RenderFailurePolicy.CONTINUE_ON_WARNING);
        this.#input.layers = [...this.#input.layers ?? []];
        // Construction rejects unserializable callbacks/handles; content validation stays report-based.
        encodeMapData(this.#input, mapRecipeByteLimit(this.#input));
    }
    get value(): SceneRecipeInput { return structuredClone(this.#input); }
    toJSON(): JsonValue { return encodeMapData({ schema: MAP_SCENE_RECIPE_SCHEMA, recipe: this.#input }, mapRecipeByteLimit(this.#input)); }
    serialize(): string { return JSON.stringify(this.toJSON()); }
    static fromJSON(input: unknown): SceneRecipe {
        const raw = typeof input === 'string' ? JSON.parse(input) : input;
        const payload = decodeMapData(raw, mapRecipeByteLimit(raw?.recipe)) as {
            schema?: string;
            recipe?: SceneRecipeInput;
        };
        if (payload.schema !== MAP_SCENE_RECIPE_SCHEMA || !payload.recipe)
            throw new TypeError('Unsupported MapScene recipe schema');
        return new SceneRecipe(payload.recipe);
    }
}
