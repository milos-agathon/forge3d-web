import { describe, it, expect } from "vitest";
import { VectorLayers, VectorPicker, pickVectorTerrain, Forge3DScene } from "../../src-ts/index.js";
import { compileVectorPacket, triangulateVectorPolygon } from "../../src-ts/vector-geometry.js";
import { vectorLassoContains } from "../../src-ts/vector-picking.js";
const feature = { id: 0xffffffff, kind: "point" as const, position: [0, 1, 0] as [
        number,
        number,
        number
    ] };
describe("W12 vector contracts", () => {
    it("coalesces pointer hover readbacks and removes listeners on disposal", async () => {
        const layers = new VectorLayers();
        layers.add({ name: "hover", features: [{ ...feature, id: 9 }, { ...feature, id: 2 }] });
        const listeners = new Map<string, (event: any) => void>();
        const canvas = { width: 2, height: 1, getBoundingClientRect: () => ({ left: 0, top: 0, width: 2, height: 1 }),
            addEventListener: (type: string, callback: any) => listeners.set(type, callback),
            removeEventListener: (type: string) => listeners.delete(type) } as unknown as HTMLCanvasElement;
        const resolvers: Array<(value: any) => void> = [];
        const picker = new VectorPicker({ readVectorPickMap: () => new Promise(resolve => resolvers.push(resolve)) }, layers);
        const hits: number[] = [];
        picker.bind(canvas, { hover: true, onPick: hit => hits.push(hit!.id) });
        for (let i = 0; i < 100; i++) listeners.get("pointermove")!({ clientX: i % 2, clientY: 0 });
        expect(resolvers).toHaveLength(1);
        const map = { width: 2, height: 1, ids: new Uint32Array([9, 2]), depth: new Float32Array(2), worldPositions: new Float32Array(6) };
        resolvers[0]!(map);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(resolvers).toHaveLength(2);
        resolvers[1]!(map);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(hits).toEqual([2]);
        expect(layers.snapshot().hover).toBe(2);
        picker.dispose();
        expect(listeners.size).toBe(0);
    });
    it("samples polygon interiors over terrain hills rather than only the boundary", () => { const l = new VectorLayers(); l.add({ name: "hill", features: [{ id: 1, kind: "polygon", rings: [[[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]]] }], style: { drape: true, drapeOffset: .02 } }); const p = compileVectorPacket(l, { width: 3, height: 3, spacing: [1, 1], domain: [0, 1], heights: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]) }); expect(p.vertices.some(v => v[0] === 0 && v[2] === 0 && Math.abs(v[1]! - 1.02) < 1e-6)).toBe(true); });
    it("preserves full uint32 IDs through edits and rolls back invalid changes", () => { const layers = new VectorLayers(), handle = layers.add({ name: "a", features: [feature] }); handle.updateFeature(feature.id, { ...feature, position: [1, 1, 1] }); expect(handle.snapshot().features[0]!.id).toBe(0xffffffff); const before = layers.snapshot(); expect(() => layers.add({ name: "b", features: [feature] })).toThrow(/duplicate/); expect(layers.snapshot()).toEqual(before); expect(() => handle.updateFeature(feature.id, { ...feature, id: 2 })).toThrow(/preserve/); });
    it("copies snapshots and propagates handle revisions into scenes", () => { const layers = new VectorLayers(), h = layers.add({ name: "a", features: [feature] }); const scene = Forge3DScene.create(); scene.setVectorLayers(layers); const revision = scene.revision; h.update({ visible: false }); expect(scene.revision).toBeGreaterThan(revision); const copy = scene.copy(); h.update({ visible: true }); expect(copy.snapshot().vectors!.layers[0]!.visible).toBe(false); });
    it("triangulates concave rings and subtracts holes", () => { const tris = triangulateVectorPolygon([[[-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2]], [[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]]]); const area = tris.reduce((n, [a, b, c]) => n + Math.abs((b![0] - a![0]) * (c![2] - a![2]) - (b![2] - a![2]) * (c![0] - a![0])) / 2, 0); expect(area).toBeCloseTo(12, 8); expect(() => triangulateVectorPolygon([[[0, 0, 0], [1, 0, 1], [0, 0, 1], [1, 0, 0]]])).toThrow(); });
    it("drapes bilinearly in centered coordinates with domain and exaggeration", () => { const layers = new VectorLayers(); layers.add({ name: "drape", features: [{ ...feature, position: [0, 100, 0] }], style: { drape: true, drapeOffset: .5 } }); const packet = compileVectorPacket(layers, { width: 2, height: 2, heights: new Float32Array([10, 20, 30, 40]), spacing: [2, 2], domain: [10, 40], exaggeration: 2 }); expect(packet.vertices[0]![1]).toBeCloseTo(30.5); expect(() => compileVectorPacket(layers)).toThrow(/require terrain/); });
    it("emits cap, join and closed extrusion geometry with stable feature IDs", () => { const layers = new VectorLayers(); layers.add({ name: "line", features: [{ id: 12, kind: "line", positions: [[-1, 0, 0], [0, 0, 0], [0, 0, 1]] }], style: { cap: "round", join: "round" } }); const packet = compileVectorPacket(layers); expect(packet.vertices.length).toBe(30); expect(packet.vertices.every(v => v[20] === 12)).toBe(true); const polygon = new VectorLayers(); polygon.add({ name: "wall", features: [{ id: 3, kind: "polygon", rings: [[[0, 0, 0], [1, 0, 0], [0, 0, 1]]] }], style: { extrusion: 4 } }); const wall = compileVectorPacket(polygon); expect(wall.vertices.length).toBe(24); expect(wall.vertices.slice(0, 3).every(v => v[3] === 4)).toBe(true); expect(wall.vertices.slice(3, 6).every(v => v[3] === 0)).toBe(true); });
    it("validates atlas tiles and point LOD", () => { const l = new VectorLayers(); expect(() => l.add({ name: "a", features: [feature], style: { shape: "texture" } })).toThrow(/atlas/); l.add({ name: "a", features: [feature], style: { shape: "texture", pointSize: 10, lodThreshold: 2 }, atlas: { width: 2, height: 2, tileSize: 2, rgba: new Uint8Array(16).fill(255) } }); expect(compileVectorPacket(l).vertices[0]![21]).toBe(5); expect(() => l.add({ name: "b", features: [{ ...feature, id: 2 }], style: { color: [2, 0, 0, 1] } })).toThrow(); });
    it("orders graph edges below nodes and rejects incomplete graphs atomically", () => { const l = new VectorLayers(); expect(() => l.addGraph({ name: "bad", nodes: [], edges: [{ id: 1, source: 2, target: 3 }] })).toThrow(/unknown/); expect(l.snapshot().layers).toHaveLength(0); l.addGraph({ name: "graph", nodes: [{ id: 1, position: [0, 0, 0] }, { id: 2, position: [1, 0, 0] }], edges: [{ id: 3, source: 1, target: 2 }] }); expect(l.snapshot().layers.map(x => x.name)).toEqual(["graph:edges", "graph:nodes"]); });
    it("restores named selections and removes deleted IDs", () => { const l = new VectorLayers(), h = l.add({ name: "a", features: [feature] }); l.setSelection("a", [feature.id], { outline: true, glow: true }); l.setHover(feature.id); expect(VectorLayers.from(l.snapshot()).snapshot()).toEqual(l.snapshot()); h.removeFeature(feature.id); expect(l.getSelection("a")!.ids).toEqual([]); expect(l.snapshot().hover).toBeNull(); });
    it("picks actual visible pixels and returns sorted unique lasso IDs", async () => { const l = new VectorLayers(); l.add({ name: "a", features: [{ ...feature, id: 9 }, { ...feature, id: 2 }] }); const target = { readVectorPickMap: async () => ({ width: 2, height: 2, ids: new Uint32Array([9, 2, 9, 0]), depth: new Float32Array([.4, .3, .4, 1]), worldPositions: new Float32Array(12) }) }; const p = new VectorPicker(target, l); expect((await p.point(1, 0))!.id).toBe(2); expect(await p.point(-1, 0)).toBeNull(); expect((await p.lasso([[0, 0], [2, 0], [2, 2], [0, 2]])).map(x => x.id)).toEqual([2, 9]); expect((await p.rect(0, 0, 1, 2)).map(x => x.id)).toEqual([9]); });
    it("supports cancellation before and after readback and terminal disposal", async () => { const l = new VectorLayers(); let resolve!: (value: any) => void; const target = { readVectorPickMap: () => new Promise<any>(r => { resolve = r; }) }; const p = new VectorPicker(target, l), a = new AbortController(); a.abort(); await expect(p.point(0, 0, { signal: a.signal })).rejects.toMatchObject({ code: "REQUEST_CANCELLED" }); const b = new AbortController(), pending = p.point(0, 0, { signal: b.signal }); b.abort(); resolve({ width: 1, height: 1, ids: new Uint32Array(1), depth: new Float32Array(1), worldPositions: new Float32Array(3) }); await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" }); p.dispose(); await expect(p.point(0, 0)).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" }); });
    it("includes lasso edges and hits a real terrain surface", () => { expect(vectorLassoContains(1, 0, [[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(true); const hit = pickVectorTerrain({ width: 2, height: 2, heights: new Float32Array(4), domain: [0, 1] }, { position: [0, 5, 0], target: [0, 0, 0], up: [0, 0, -1], fovYDegrees: 45, near: .1, far: 20 }, 50, 50, { width: 100, height: 100 }); expect(hit!.worldPosition[1]).toBeCloseTo(0); });
});
