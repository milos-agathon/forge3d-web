import { Forge3DError } from "./index.js";
import { Camera } from "./camera.js";
import { TerrainDataset } from "./terrain-dataset.js";
import { VectorLayers, vectorInvalid } from "./vector-layers.js";
import type { CameraInput, TerrainHeightmapInput } from "./index.js";
import type { PickOptions, TerrainPickResult, VectorPickMap, VectorPickResult, VectorSnapshot } from "./vector-types.js";
export interface VectorPickTarget {
    readVectorPickMap(): Promise<VectorPickMap>;
}
function abort(signal?: AbortSignal): void { if (signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "Pick was cancelled"); }
export function vectorLassoContains(x: number, y: number, points: readonly (readonly [
    number,
    number
])[]): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i]!, b = points[j]!;
        const cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
        if (Math.abs(cross) < 1e-8 && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1]))
            return true;
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])
            inside = !inside;
    }
    return inside;
}
/** Queries use device pixels, with deterministic numeric-ID ordering for areas. */
export class VectorPicker {
    #disposed = false;
    readonly #detach = new Set<() => void>();
    constructor(private readonly target: VectorPickTarget, private readonly layers: VectorLayers | (() => VectorSnapshot)) { }
    #guard(): void { if (this.#disposed)
        throw new Forge3DError("RUNTIME_DISPOSED", "Picker is disposed"); }
    #snapshot(): VectorSnapshot { return this.layers instanceof VectorLayers ? this.layers.snapshot() : this.layers(); }
    async #map(options: PickOptions): Promise<{
        map: VectorPickMap;
        snapshot: VectorSnapshot;
    }> { this.#guard(); abort(options.signal); const snapshot = this.#snapshot(); const map = await this.target.readVectorPickMap(); this.#guard(); abort(options.signal); return { map, snapshot }; }
    #result(map: VectorPickMap, snapshot: VectorSnapshot, index: number): VectorPickResult | null {
        const id = map.ids[index] ?? 0;
        if (id === 0)
            return null;
        for (const layer of snapshot.layers) {
            const feature = layer.features.find(f => f.id === id);
            if (feature)
                return { id, layerId: layer.layerId, layerName: layer.name, kind: feature.kind, properties: structuredClone(feature.properties ?? {}), pixel: [index % map.width, Math.floor(index / map.width)], depth: map.depth[index] ?? 1, worldPosition: [map.worldPositions[index * 3] ?? 0, map.worldPositions[index * 3 + 1] ?? 0, map.worldPositions[index * 3 + 2] ?? 0] };
        }
        return null;
    }
    async point(x: number, y: number, options: PickOptions = {}): Promise<VectorPickResult | null> { if (!Number.isFinite(x) || !Number.isFinite(y))
        throw vectorInvalid("pick coordinates must be finite"); const { map, snapshot } = await this.#map(options); const px = Math.floor(x), py = Math.floor(y); if (px < 0 || py < 0 || px >= map.width || py >= map.height)
        return null; return this.#result(map, snapshot, py * map.width + px); }
    async rect(x: number, y: number, width: number, height: number, options: PickOptions = {}): Promise<VectorPickResult[]> { if ([x, y, width, height].some(v => !Number.isFinite(v)) || width < 0 || height < 0)
        throw vectorInvalid("invalid pick rectangle"); const { map, snapshot } = await this.#map(options); return this.#area(map, snapshot, (px, py) => px >= x && px < x + width && py >= y && py < y + height, options); }
    async lasso(points: readonly (readonly [
        number,
        number
    ])[], options: PickOptions = {}): Promise<VectorPickResult[]> { if (points.length < 3 || points.length > 1000 || points.some(p => p.length !== 2 || p.some(x => !Number.isFinite(x))))
        throw vectorInvalid("lasso needs 3 to 1000 finite points"); const { map, snapshot } = await this.#map(options); return this.#area(map, snapshot, (x, y) => vectorLassoContains(x, y, points), options); }
    #area(map: VectorPickMap, snapshot: VectorSnapshot, contains: (x: number, y: number) => boolean, options: PickOptions): VectorPickResult[] { const ids = new Map<number, VectorPickResult>(); for (let i = 0; i < map.ids.length; i++) {
        if (i % map.width === 0)
            abort(options.signal);
        const id = map.ids[i] ?? 0;
        if (id && !ids.has(id) && contains(i % map.width + .5, Math.floor(i / map.width) + .5)) {
            const hit = this.#result(map, snapshot, i);
            if (hit)
                ids.set(id, hit);
        }
    } return [...ids.values()].sort((a, b) => a.id - b.id); }
    /** CSS pointer coordinates are converted to current canvas device pixels. */
    bind(canvas: HTMLCanvasElement, options: {
        onPick?: (hit: VectorPickResult | null) => void;
        onError?: (error: unknown) => void;
        hover?: boolean;
        select?: boolean;
        invalidate?: () => void;
    } = {}): () => void {
        this.#guard();
        let serial = 0, detached = false, busy = false;
        type Request = { x: number; y: number; hover: boolean; serial: number };
        let pendingHover: Request | undefined, pendingClick: Request | undefined;
        const controller = new AbortController();
        const drain = async (): Promise<void> => {
            busy = true;
            try {
                while (!detached && (pendingClick || pendingHover)) {
                    const request = pendingClick ?? pendingHover!;
                    if (pendingClick) pendingClick = undefined;
                    else pendingHover = undefined;
                    try {
                        const hit = await this.point(request.x, request.y, { signal: controller.signal });
                        if (detached || (request.hover && request.serial !== serial)) continue;
                        if (this.layers instanceof VectorLayers) {
                            if (request.hover) this.layers.setHover(hit?.id ?? null);
                            else if (options.select) this.layers.setSelection("active", hit ? [hit.id] : []);
                        }
                        options.onPick?.(hit);
                        options.invalidate?.();
                    } catch (error) {
                        if (!detached) options.onError?.(error);
                    }
                }
            } finally { busy = false; }
        };
        const handle = (event: PointerEvent, hover: boolean): void => {
            if (detached) return;
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const request = { x: (event.clientX - rect.left) * canvas.width / rect.width,
                y: (event.clientY - rect.top) * canvas.height / rect.height, hover, serial: ++serial };
            if (hover) pendingHover = request;
            else { pendingClick = request; pendingHover = undefined; }
            if (!busy) void drain();
        };
        const click = (event: PointerEvent) => handle(event, false), move = (event: PointerEvent) => handle(event, true);
        canvas.addEventListener("pointerup", click);
        if (options.hover)
            canvas.addEventListener("pointermove", move);
        const detach = () => { if (detached)
            return; detached = true; pendingClick = pendingHover = undefined; serial++; controller.abort(); canvas.removeEventListener("pointerup", click); canvas.removeEventListener("pointermove", move); this.#detach.delete(detach); };
        this.#detach.add(detach);
        return detach;
    }
    dispose(): void { for (const detach of this.#detach)
        detach(); this.#disposed = true; }
}
/** Terrain ray cast against the bilinear heightfield used by draping. */
export function pickVectorTerrain(terrain: TerrainHeightmapInput, camera: CameraInput, x: number, y: number, viewport: {
    width: number;
    height: number;
}): TerrainPickResult | null {
    const dataset = TerrainDataset.fromArray(terrain), ray = new Camera(camera).screenRay(x, y, viewport);
    const hx = (dataset.width - 1) * dataset.spacing[0] / 2, hz = (dataset.height - 1) * dataset.spacing[1] / 2;
    let entry = 0, exit = camera.far;
    for (const [axis, half] of [[0, hx], [2, hz]] as const) {
        const direction = ray.direction[axis], origin = ray.origin[axis];
        if (Math.abs(direction) < 1e-12) {
            if (Math.abs(origin) > half)
                return null;
        }
        else {
            const a = (-half - origin) / direction, b = (half - origin) / direction;
            entry = Math.max(entry, Math.min(a, b));
            exit = Math.min(exit, Math.max(a, b));
        }
    }
    if (exit < entry)
        return null;
    const sample = (t: number) => { const px = ray.origin[0] + ray.direction[0] * t, pz = ray.origin[2] + ray.direction[2] * t; const q = dataset.query(Math.max(-hx, Math.min(hx, px)), Math.max(-hz, Math.min(hz, pz))); return { q, delta: ray.origin[1] + ray.direction[1] * t - (q?.worldPosition[1] ?? NaN) }; };
    const step = Math.min(dataset.spacing[0], dataset.spacing[1]) * .25 / Math.max(Math.hypot(ray.direction[0], ray.direction[2]), 1e-6);
    const count = Math.min(100000, Math.max(1, Math.ceil((exit - entry) / step)));
    let previous = sample(entry), previousT = entry;
    for (let i = 1; i <= count; i++) {
        const t = entry + (exit - entry) * i / count, current = sample(t);
        if (Number.isFinite(previous.delta) && Number.isFinite(current.delta) && previous.delta * current.delta <= 0) {
            let lo = previousT, hi = t;
            for (let j = 0; j < 32; j++) {
                const mid = (lo + hi) / 2, v = sample(mid);
                if (previous.delta * v.delta > 0)
                    lo = mid;
                else
                    hi = mid;
            }
            const distance = (lo + hi) / 2, q = sample(distance).q;
            if (q)
                return { kind: "terrain", worldPosition: q.worldPosition, normal: q.normal, distance };
        }
        previous = current;
        previousT = t;
    }
    return null;
}
