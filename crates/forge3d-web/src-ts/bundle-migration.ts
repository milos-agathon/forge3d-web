import { Diagnostic, ValidationReport, type JsonValue } from './diagnostics.js';
import { SceneState, type SceneStateInput, type CameraBookmark, type ScenePreset } from './scene-review.js';
import type { MapSceneLayerInput, SceneRecipeInput } from './map-scene-types.js';
import type { VectorFeature, VectorPosition, VectorColor } from './vector-types.js';
import { bundleFailure, bundlePath } from './bundle-archive.js';
type RecordValue = Record<string, any>;
/** Native directories can be zipped without altering their checked payloads. Unknown native intent is preserved and diagnosed. */
export function migrateNativeBundle(manifest: RecordValue, files: Record<string, Uint8Array>, baseRecipe?: SceneRecipeInput): SceneState {
    const json = (path: string, fallback: any) => files[path] ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files[path])) : fallback;
    const legacy = manifest.version === 2 ? json('scene/state.json', null) : { base: { preset: json('render/preset.json', manifest.preset ?? null), camera_bookmarks: json('camera/bookmarks.json', manifest.camera_bookmarks ?? []), vector_overlays: json('overlays/vectors.geojson', []), labels: json('overlays/labels.json', []) } };
    if (!legacy || typeof legacy !== 'object') bundleFailure('Native scene state missing');
    const diagnostics: Diagnostic[] = [], unsupported = (field: string, value: unknown) => diagnostics.push(new Diagnostic({ code: 'unsupported_bundle_field', severity: 'error', message: `Native bundle field needs a browser adapter: ${field}`, remediation: 'Use the preserved native state to supply a typed browser equivalent.', support_level: 'unsupported', details: { field, value } }));
    const asset = (path: string) => { bundlePath(path); if (!files[path]) bundleFailure(`Missing native asset: ${path}`); return 'forge3d-asset:' + path; };
    const bookmarks: CameraBookmark[] = (legacy.base?.camera_bookmarks ?? manifest.camera_bookmarks ?? []).map((b: RecordValue) => ({ name: b.name, eye: b.eye, target: b.target, ...(b.up ? { up: b.up } : {}), ...(b.fov_deg !== undefined ? { fovDegrees: b.fov_deg } : {}) }));
    const bookmark = bookmarks[0], recipe: SceneRecipeInput = baseRecipe ? structuredClone(baseRecipe) : { crs: manifest.terrain?.crs ?? 'LOCAL', camera: bookmark ? { position: bookmark.eye, target: bookmark.target, up: bookmark.up ?? [0, 1, 0], fovYDegrees: bookmark.fovDegrees ?? 45, near: .1, far: 100000 } : { kind: 'orbit-camera', target: [0, 0, 0], distance: 100 }, output: { width: 512, height: 512 }, layers: [] };
    const preset = (p: RecordValue | null | undefined): Partial<ScenePreset> | undefined => {
        if (!p) return undefined; const converted: Partial<ScenePreset> = {};
        if (typeof p.exposure === 'number') converted.postFx = { effects: [{ kind: 'tonemap', operator: 'exposure', exposure: p.exposure }] };
        for (const [key, value] of Object.entries(p)) if (key !== 'exposure') unsupported(`preset.${key}`, value);
        return converted;
    };
    const layers = (raw: RecordValue, prefix: string): MapSceneLayerInput[] => {
        const result: MapSceneLayerInput[] = []; let next = 1;
        for (const [i, overlay] of (raw.raster_overlays ?? []).entries()) result.push({ kind: 'raster', layerId: `${prefix}:raster:${i}`, source: { id: `${prefix}:raster-data:${i}`, format: /\.jpe?g$/i.test(overlay.path) ? 'jpg' : 'png', crs: recipe.crs ?? 'LOCAL', url: asset(overlay.path) }, options: { opacity: overlay.opacity ?? 1, zOrder: overlay.z_order ?? i, ...(overlay.extent ? { bounds: overlay.extent } : {}) } });
        for (const [i, overlay] of (raw.vector_overlays ?? []).entries()) {
            const vertices = overlay.vertices as unknown[], indices = overlay.indices as number[], primitive = String(overlay.primitive ?? 'points').toLowerCase(), features: VectorFeature[] = [];
            if (!Array.isArray(vertices) || !Array.isArray(indices)) { unsupported(`vector_overlays.${i}`, overlay); continue; }
            const vertex = (index: number): { position: VectorPosition; color: VectorColor } => {
                const v = vertices[index] as any; if (!v) bundleFailure('Native vector index out of bounds');
                const p: VectorPosition = Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z], c: VectorColor = Array.isArray(v) ? [v[3] ?? 1, v[4] ?? 1, v[5] ?? 1, v[6] ?? 1] : [v.r ?? 1, v.g ?? 1, v.b ?? 1, v.a ?? 1];
                if ([...p, ...c].some(n => typeof n !== 'number' || !Number.isFinite(n))) bundleFailure('Invalid native vector vertex'); return { position: p, color: c };
            };
            const step = primitive === 'triangles' ? 3 : primitive === 'lines' ? 2 : primitive === 'points' ? 1 : 0;
            if (!step || indices.length % step) { unsupported(`vector_overlays.${i}.primitive`, primitive); continue; }
            for (let j = 0; j < indices.length; j += step) {
                const group = indices.slice(j, j + step).map(vertex), first = group[0]!, style = { color: first.color, opacity: overlay.opacity ?? 1, pointSize: overlay.point_size ?? 4, lineWidth: overlay.line_width ?? 1, drape: overlay.drape ?? false, drapeOffset: overlay.drape_offset ?? 0, depthBias: overlay.depth_bias ?? 0 };
                if (group.some(g => g.color.some((v, k) => v !== first.color[k]))) unsupported(`vector_overlays.${i}.vertex_colors`, 'Per-vertex colors preserved in nativeSceneState');
                if (step === 1) features.push({ id: next++, kind: 'point', position: first.position, style });
                if (step === 2) features.push({ id: next++, kind: 'line', positions: group.map(g => g.position), style });
                if (step === 3) features.push({ id: next++, kind: 'polygon', rings: [group.map(g => g.position)], style });
            }
            result.push({ kind: 'vector', layerId: `${prefix}:vector:${i}`, source: { id: `${prefix}:vector-data:${i}`, format: 'vector', crs: recipe.crs ?? 'LOCAL', data: { name: overlay.name ?? `${prefix}:${i}`, features, zOrder: overlay.z_order ?? i } } });
        }
        if (raw.labels?.length) result.push({ kind: 'labels', layerId: `${prefix}:labels`, source: { id: `${prefix}:labels-data`, format: 'labels', crs: recipe.crs ?? 'LOCAL', data: raw.labels.map((l: RecordValue, i: number) => ({ ...l, id: l.id ?? `${prefix}:${i}`, geometry_type: l.kind === 'line' ? 'LineString' : l.kind === 'curved' ? 'curved' : 'Point' })) }, coordinateSpace: 'world' });
        if (raw.scatter_batches?.length) unsupported(`${prefix}.scatter_batches`, raw.scatter_batches);
        return result;
    };
    if (manifest.terrain) {
        const meta = manifest.terrain, path = meta.dem_path;
        if (typeof path !== 'string') bundleFailure('Invalid native terrain metadata');
        if (/\.tiff?$/i.test(path)) recipe.terrain = { source: { id: 'native:dem', format: 'geotiff', crs: meta.crs ?? recipe.crs ?? 'LOCAL', url: asset(path), parameters: { ...(meta.domain ? { domain: meta.domain } : {}) } } };
        else unsupported('terrain.dem_path', path);
    }
    Object.assign(recipe, preset(legacy.base?.preset)); recipe.layers = [...recipe.layers ?? [], ...layers(legacy.base ?? {}, 'native-base')];
    const reviewLayers = (legacy.review_layers ?? []).map((l: RecordValue, i: number) => ({ id: l.id, ...(l.name ? { name: l.name } : {}), ...(l.description ? { description: l.description } : {}), layers: layers(l, `native-review-${i}`) }));
    const variants = (legacy.variants ?? []).map((v: RecordValue) => ({ id: v.id, activeLayerIds: v.active_layer_ids ?? [], ...(v.name ? { name: v.name } : {}), ...(v.description ? { description: v.description } : {}), ...(v.preset ? { preset: preset(v.preset) } : {}) }));
    const report = new ValidationReport({ ...(legacy.validation_report ?? {}), diagnostics: [...legacy.validation_report?.diagnostics ?? [], ...diagnostics] });
    return new SceneState({ base: recipe, cameraBookmarks: bookmarks, reviewLayers, variants, activeVariantId: legacy.active_variant_id ?? null, validationReport: report.toJSON(), nativeSceneState: { manifest, scene: legacy } as JsonValue });
}
