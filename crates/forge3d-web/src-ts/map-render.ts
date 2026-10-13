import { Forge3DRuntime, Forge3DError } from './index.js';
import type { Forge3DRuntimeOptions, CameraInput } from './index.js';
import { Camera } from './camera.js';
import { Forge3DScene } from './scene.js';
import { Frame } from './frames.js';
import { PointCloudRenderer } from './pointcloud-renderer.js';
import { PathTracer } from './path-tracer.js';
import { SdfScene } from './sdf.js';
import { mapCamera } from './map-recipe.js';
import { mapCancelled } from './map-resource-loader.js';
import { MAP_SCENE_DEFAULT_BUDGET } from './map-validation.js';
import type { PreparedMapLayers } from './map-layer-adapters.js';
import type { SceneRecipeInput, MapSceneRenderOptions, MapFrameMetrics } from './map-scene-types.js';
/** Convert the point renderer's hardware depth to W06 normalized view-space depth. */
export function mapLinearDepth(depth: Float32Array, camera: CameraInput): Float32Array {
    if (camera.projection === 'orthographic')
        return depth.slice();
    const { near, far } = camera;
    return depth.map(z => z >= 1 ? 1 : (near * far / (far - z * (far - near)) - near) / (far - near));
}
export function mapHardwareDepth(depth: Float32Array, camera: CameraInput): Float32Array {
    if (camera.projection === 'orthographic')
        return depth.slice();
    const { near, far } = camera;
    return depth.map(d => d >= 1 ? 1 : far / (far - near) - far * near / ((near + d * (far - near)) * (far - near)));
}
export function compositeMapPoints(base: Uint8Array, baseDepth: Float32Array, points: Uint8Array, pointDepth: Float32Array): Uint8Array {
    if (base.length !== points.length || base.length !== baseDepth.length * 4 || baseDepth.length !== pointDepth.length)
        throw Error('Map composition dimensions differ');
    const output = base.slice();
    for (let i = 0; i < baseDepth.length; i++)
        if (pointDepth[i]! < 1 && pointDepth[i]! <= baseDepth[i]! + 1e-6 && points[i * 4 + 3]! > 0) {
            const a = points[i * 4 + 3]! / 255;
            for (let c = 0; c < 3; c++)
                output[i * 4 + c] = Math.min(255, Math.round(points[i * 4 + c]! + output[i * 4 + c]! * (1 - a)));
            output[i * 4 + 3] = Math.round((a + (output[i * 4 + 3]! / 255) * (1 - a)) * 255);
        }
    return output;
}
export function mapCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
    if (typeof OffscreenCanvas !== 'undefined')
        return new OffscreenCanvas(width, height);
    if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        return c;
    }
    throw new Forge3DError('UNSUPPORTED_FEATURE', 'MapScene WebGPU rendering requires a browser canvas');
}
export async function renderMapFrame(input: SceneRecipeInput, layers: PreparedMapLayers, options: MapSceneRenderOptions, signal: AbortSignal, onMemory: (bytes: number) => void): Promise<{
    frame: Frame;
    metrics: MapFrameMetrics;
}> {
    const { width, height } = input.output, budget = input.diagnosticsPolicy?.gpuMemoryBudgetBytes ?? MAP_SCENE_DEFAULT_BUDGET;
    const releases: (() => void)[] = [];
    let peak = 0, current = 0;
    const memory = (bytes: number) => { current = bytes; peak = Math.max(peak, bytes); onMemory(bytes); if (bytes > budget)
        throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Combined MapScene GPU allocations exceed budget', { bytes, budget }); };
    try {
        mapCancelled(signal);
        const trace = input.layers?.find(l => l.kind === 'trace');
        if (trace?.kind === 'trace') {
            const c = mapCamera(input.camera), tracer = await PathTracer.create({ width, height, backend: input.reproducibility?.rendererBackend ?? 'webgpu', seed: input.reproducibility?.seed ?? 0, maxBounces: trace.maxBounces ?? 4, memoryBudgetBytes: budget, camera: { origin: c.position, target: c.target, up: c.up, fovY: c.fovYDegrees } });
            releases.push(() => tracer.dispose());
            mapCancelled(signal);
            const { kind, layerId, supportLevel, metadata, instancingPath, requestedStats, sdf, samples, maxBounces, ...scene } = trace;
            await tracer.setScene({ ...scene, ...(sdf ? { sdf: SdfScene.fromSnapshot(sdf) } : {}) });
            mapCancelled(signal);
            const result = await tracer.render({ spp: samples ?? 16, signal });
            memory(tracer.memoryReport().gpuBytes);
            const rgba = new Uint8Array(width * height * 4);
            let coverage = 0;
            for (let i = 0; i < width * height; i++) {
                if (result.depth[i]! > 0 && Number.isFinite(result.depth[i]))
                    coverage++;
                for (let c = 0; c < 3; c++) {
                    const x = result.color[i * 3 + c]!, linear = x / (1 + x), srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
                    rgba[i * 4 + c] = Math.round(Math.min(1, Math.max(0, srgb)) * 255);
                }
                rgba[i * 4 + 3] = 255;
            }
            if (!coverage)
                throw new Forge3DError('UNSUPPORTED_FEATURE', 'MapScene trace contains no visible geometry', { reason: 'empty-render-output' });
            return { frame: new Frame(width, height, rgba), metrics: { gpuBytes: current, peakGpuBytes: peak, coveragePixels: coverage, drawCalls: 0, pointCount: 0, backend: tracer.backend } };
        }
        const camera = mapCamera(input.camera), settings: Forge3DRuntimeOptions = { ...input.runtimeOptions, clearColor: input.runtimeOptions?.clearColor ?? [0.02, 0.03, 0.05, 1], width, height, devicePixelRatio: 1, memoryBudgetBytes: budget };
        let scene = layers.scene;
        const overlayScene = Forge3DScene.create();
        releases.push(() => overlayScene.dispose());
        if (scene.snapshot().nodes.some(n=>n.node.kind==='overlay')) {
            scene = scene.copy();
            releases.push(() => scene.dispose());
            for (const n of scene.snapshot().nodes)
                if (n.node.kind === 'overlay') {
                    overlayScene.addNode(n.node);
                    scene.removeNode(n.id);
                }
        }
        const runtime = await Forge3DRuntime.create(options.canvas ?? mapCanvas(width, height), settings);
        releases.push(() => runtime.dispose());
        mapCancelled(signal);
        const snapshot = scene.snapshot(), terrainNode = snapshot.nodes.find(n => n.node.kind === 'terrain')?.node;
        // Scene terrain nodes are topology markers; heightmap uploads use the terrain API.
        if (terrainNode?.kind === 'terrain')
            runtime.setTerrain(terrainNode.terrain);
        runtime.setScene(snapshot);
        runtime.setCamera(camera);
        if (!runtime.render())
            throw new Forge3DError('INTERNAL_ERROR', 'MapScene runtime declined the render');
        let rgba: Uint8Array, baseBytes = runtime.getMemoryReport().currentBytes, pointCount = 0,pointBytes=0;
        memory(baseBytes);
        const stats = runtime.getRenderStats();
        const capture = await runtime.capture({ samples: 1, aovs: ['depth'], signal });
        mapCancelled(signal);
        rgba = await runtime.readRgba();
        mapCancelled(signal);
        const baseDepth=capture.aovFrame.depth(),covered=baseDepth.map(d=>d<1?1:0);
        baseBytes=runtime.getMemoryReport().currentBytes;memory(baseBytes);
        if (layers.points.length) {
            const pointBudget = budget - baseBytes;
            if (pointBudget < width * height * 16)
                throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'No budget remains for point rendering');
            const points = await PointCloudRenderer.create(mapCanvas(width, height), { memoryBudgetBytes: pointBudget, clearColor: [0, 0, 0, 0] });
            releases.push(() => points.dispose());
            mapCancelled(signal);
            points.setLayers(layers.points);
            points.setOcclusionDepth(mapHardwareDepth(capture.aovFrame.depth(), camera));
            const c = new Camera(camera);
            await points.render({ position: camera.position, viewportHeight: height, fovY: camera.fovYDegrees * Math.PI / 180, viewProjection: c.viewProjectionMatrix(width / height) }, signal);
            const pointPixels = await points.readRgba(signal), depth = await points.readDepth(signal);
            pointCount = points.getStats().pointsRendered;
            memory(baseBytes + points.getStats().peakGpuBytes);
            pointBytes=points.getStats().gpuBytes;
            const pointDepth=mapLinearDepth(depth,camera);
            rgba = compositeMapPoints(rgba, baseDepth, pointPixels, pointDepth);
            for(let i=0;i<covered.length;i++)if(pointPixels[i*4+3]!>0&&pointDepth[i]!<1&&pointDepth[i]!<=baseDepth[i]!+1e-6)covered[i]=1;
        }
            if (overlayScene.snapshot().nodes.length) {
                const remaining = budget - baseBytes - pointBytes;
                const overlay = await Forge3DRuntime.create(mapCanvas(width, height), { ...settings, memoryBudgetBytes: remaining, clearColor: [0, 0, 0, 0], alphaMode: 'premultiplied' });
                releases.push(() => overlay.dispose());
                mapCancelled(signal);
                overlay.setScene(overlayScene.snapshot());
                overlay.setCamera(camera);
                if (!overlay.render())
                    throw Error('Overlay render declined');
                const front = await overlay.readRgba();
                mapCancelled(signal);
                memory(baseBytes + pointBytes + overlay.getMemoryReport().currentBytes);
                for (let i = 0; i < width * height; i++) {
                    const a = front[i * 4 + 3]! / 255;
                    if (a > 0) {
                        covered[i]=1;
                        for (let c = 0; c < 3; c++)
                            rgba[i * 4 + c] = Math.min(255, Math.round(front[i * 4 + c]! + rgba[i * 4 + c]! * (1 - a)));
                        rgba[i * 4 + 3] = Math.round((a + rgba[i * 4 + 3]! / 255 * (1 - a)) * 255);
                    }
                }
            }
        mapCancelled(signal);
        const coverage=covered.reduce((n,v)=>n+v,0);
        if (!coverage)
            throw new Forge3DError('UNSUPPORTED_FEATURE', 'MapScene rendered only the clear background', { reason: 'empty-render-output' });
        return { frame: new Frame(width, height, rgba), metrics: { gpuBytes: current, peakGpuBytes: peak, coveragePixels: coverage, drawCalls: stats.drawCalls, pointCount, backend: 'webgpu' } };
    }
    finally {
        for (const release of releases.reverse())
            release();
        onMemory(0);
    }
}
