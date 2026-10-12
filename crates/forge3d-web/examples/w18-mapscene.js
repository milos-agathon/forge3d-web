export function transform(x, y, z, scale = 1) { return new Float32Array([scale, 0, 0, x, 0, scale, 0, y, 0, 0, scale, z, 0, 0, 0, 1]); }
export function baseRecipe() {
    const size = 16, heights = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
            heights[y * size + x] = 5 * Math.exp(-((x - 7) ** 2 + (y - 7) ** 2) / 30);
    return { crs: 'LOCAL', terrain: { source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: { width: size, height: size, heights, spacing: [24 / (size - 1), 24 / (size - 1)], bounds: [-12, -12, 12, 12], domain: [0, 5], crs: 'LOCAL' } } }, camera: { position: [24, 32, 42], target: [0, 2, 0], up: [0, 1, 0], fovYDegrees: 42, near: .1, far: 500 }, lighting: { name: 'daylight' }, output: { width: 256, height: 192 }, reproducibility: { seed: 7 }, runtimeOptions: { clearColor: [.02, .03, .05, 1] }, layers: [] };
}
export function fullRecipe(api) {
    const r = baseRecipe(), box = api.generatePrimitive('box'), image = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++)
        image.set([200, 180, 80, 255], i * 4);
    r.layers = [
        { kind: 'raster', layerId: 'imagery', source: { id: 'imagery', format: 'rgba', crs: 'LOCAL', data: { width: 4, height: 4, data: image } }, options: { opacity: .35, blendMode: 'multiply' } },
        { kind: 'vector', layerId: 'roads', source: { id: 'roads', format: 'vector', crs: 'LOCAL', data: { name: 'roads', features: [{ id: 11, kind: 'line', positions: [[-10, 6, -2], [10, 6, -2]], style: { lineWidth: 4, color: [.1, .4, 1, 1] } }] } } },
        { kind: 'mesh', layerId: 'mesh', source: { id: 'mesh', format: 'mesh', crs: 'LOCAL', data: box }, transforms: transform(-5, 5, 2, 2) },
        { kind: 'buildings', layerId: 'buildings', source: { id: 'buildings', format: 'buildings', crs: 'LOCAL', data: [{ id: 'warehouse', mesh: box }] }, transforms: transform(5, 5, 2, 3) },
        { kind: 'scatter', layerId: 'instances', batches: [{ name: 'instances', levels: [{ mesh: box }], transforms: transform(0, 7, -5, 2), color: [.1, .9, .4, 1] }] },
        { kind: 'point-cloud', layerId: 'points', source: { id: 'points', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array([0, 10, 0, -6, 8, 0]), colors: new Uint8Array([255, 0, 255, 255, 180, 0]) } }, style: { pointSize: 12 } },
        { kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'labels', crs: 'LOCAL', data: [{ id: 'title', text: 'Harbor', geometry: { type: 'Point', coordinates: [36, 26, 0] } }] }, style: { fontSize: 15, color: [1, 1, 1, 1], haloWidth: 0 } },
        { kind: 'nodes', layerId: 'annotation', nodes: [{ kind: 'overlay', name: 'annotation', bounds: [218, 14, 28, 14], color: [1, .2, .1, .7] }] },
    ];
    return r;
}
export async function renderRecipe(api, recipe) { const scene = new api.MapScene(recipe); try {
    const result = await scene.render();
    return { data: Array.from(result.frame.data), report: result.report.toJSON(), metrics: result.metrics, layers: result.executedLayerIds, resources: result.resources, review: await scene.reviewRecord(), memory: scene.getMemoryReport() };
}
finally {
    scene.dispose();
} }
