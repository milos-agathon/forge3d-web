import { Forge3DError } from "./index.js";
import type { VectorFeature, VectorGraphInput, VectorLayerInput, VectorLayerSnapshot, VectorOitMode, VectorSelectionSet, VectorSelectionStyle, VectorSnapshot, VectorStyle } from "./vector-types.js";
export type * from "./vector-types.js";
export function vectorInvalid(message: string): Forge3DError { return new Forge3DError("INVALID_INPUT", message); }
export function validateVectorId(id: number): void {
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff)
        throw vectorInvalid("vector feature ID must be a nonzero uint32");
}
export function normalizeVectorStyle(style: VectorStyle = {}): Required<VectorStyle> {
    const s: Required<VectorStyle> = { color: [1, 1, 1, 1], opacity: 1, pointSize: 5, shape: "circle", lodThreshold: 1, atlasTile: 0, lineWidth: 2, cap: "butt", join: "miter", miterLimit: 4, drape: false, drapeOffset: .5, depthBias: .1, extrusion: 0, ...structuredClone(style) };
    if (!Array.isArray(s.color) || s.color.length !== 4 || s.color.some(x => !Number.isFinite(x) || x < 0 || x > 1))
        throw vectorInvalid("color components must be in [0,1]");
    for (const key of ["opacity", "pointSize", "lodThreshold", "atlasTile", "lineWidth", "miterLimit", "drapeOffset", "depthBias", "extrusion"] as const)
        if (!Number.isFinite(s[key]))
            throw vectorInvalid(`${key} must be finite`);
    if (s.opacity < 0 || s.opacity > 1 || s.pointSize < .1 || s.pointSize > 4096 || s.lineWidth < .1 || s.lineWidth > 4096 || s.lodThreshold < 0 || s.miterLimit < 1 || s.miterLimit > 64 || s.depthBias < .01 || s.depthBias > 10 || s.extrusion < 0 || !Number.isInteger(s.atlasTile) || s.atlasTile < 0)
        throw vectorInvalid("vector style is outside its supported range");
    if (!["circle", "square", "diamond", "triangle", "texture", "sphere"].includes(s.shape) || !["butt", "round", "square"].includes(s.cap) || !["miter", "bevel", "round"].includes(s.join) || typeof s.drape !== "boolean")
        throw vectorInvalid("invalid vector shape, cap, join or drape");
    return s;
}
function validateFeature(feature: VectorFeature): VectorFeature {
    validateVectorId(feature.id);
    const positions = feature.kind === "point" ? [feature.position] : feature.kind === "line" ? feature.positions : feature.kind === "polygon" ? feature.rings.flat() : [];
    if (positions.length === 0 || positions.some(p => !Array.isArray(p) || p.length !== 3 || p.some(x => !Number.isFinite(x) || Math.abs(x) > 1e12)))
        throw vectorInvalid("vector positions must be finite XYZ triples");
    if (feature.kind === "line" && feature.positions.length < 2)
        throw vectorInvalid("line needs at least two positions");
    if (feature.kind === "polygon" && feature.rings.some(r => r.length < 3))
        throw vectorInvalid("polygon rings need at least three positions");
    if (feature.style)
        normalizeVectorStyle(feature.style);
    return structuredClone(feature);
}
function selectionStyle(style: VectorSelectionStyle): VectorSelectionStyle {
    const normalized = { color: [1, .8, 0, .5] as [
            number,
            number,
            number,
            number
        ], outline: false, outlineWidth: 2, glow: false, glowIntensity: .5, glowRadius: 8, pulseSpeed: 0, ...structuredClone(style) };
    normalizeVectorStyle({ color: normalized.color });
    for (const key of ["outlineWidth", "glowIntensity", "glowRadius", "pulseSpeed"] as const)
        if (!Number.isFinite(normalized[key]) || normalized[key] < 0 || normalized[key] > 64)
            throw vectorInvalid(`invalid selection ${key}`);
    if (normalized.outlineWidth > 32 || normalized.glowRadius > 32)
        throw vectorInvalid("selection outline and glow radius must be at most 32 pixels");
    if (normalized.glowIntensity > 1 || typeof normalized.outline !== "boolean" || typeof normalized.glow !== "boolean")
        throw vectorInvalid("invalid selection style");
    return normalized;
}
/** Mutable layer handle. Edits are transactional and never renumber features. */
export class VectorLayer {
    constructor(private readonly owner: VectorLayers, readonly id: number) { }
    snapshot(): VectorLayerSnapshot { return this.owner.getLayer(this.id); }
    update(input: Partial<Omit<VectorLayerInput, "name">> & {
        name?: string;
    }): void { this.owner.updateLayer(this.id, input); }
    updateFeature(id: number, feature: VectorFeature): void {
        if (id !== feature.id)
            throw vectorInvalid("feature edits must preserve ID");
        const input = this.snapshot();
        const index = input.features.findIndex(f => f.id === id);
        if (index < 0)
            throw vectorInvalid("unknown feature ID");
        input.features[index] = feature;
        this.update({ features: input.features });
    }
    removeFeature(id: number): boolean { const features = this.snapshot().features; if (!features.some(f => f.id === id))
        return false; this.update({ features: features.filter(f => f.id !== id) }); return true; }
    remove(): void { this.owner.removeLayer(this.id); }
}
export class VectorLayers {
    readonly #layers = new Map<number, VectorLayerSnapshot>();
    readonly #selections = new Map<string, VectorSelectionSet>();
    #nextId = 1;
    #revision = 0;
    #geometryRevision = 0;
    #highlightRevision = 0;
    #knownFeatureIds: Set<number> | undefined;
    #disposed = false;
    #oit: VectorOitMode = "auto";
    #culling: VectorSnapshot["culling"] = "auto";
    #hover: number | null = null;
    #hoverStyle: VectorSelectionStyle = selectionStyle({ color: [.5, .8, 1, .3] });
    #time = 0;
    get revision(): number { return this.#revision; }
    get geometryRevision(): number { return this.#geometryRevision; }
    get highlightRevision(): number { return this.#highlightRevision; }
    get disposed(): boolean { return this.#disposed; }
    #guard(): void { if (this.#disposed)
        throw new Forge3DError("RUNTIME_DISPOSED", "Vector layers are disposed"); }
    add(input: VectorLayerInput): VectorLayer {
        this.#guard();
        const id = this.#nextId;
        const layer = this.#normalize({ ...input, layerId: id });
        this.#layers.set(id, layer);
        this.#nextId++;
        this.#revision++;
        this.#geometryRevision++;
        this.#knownFeatureIds = undefined;
        return new VectorLayer(this, id);
    }
    addGraph(input: VectorGraphInput): {
        nodes: VectorLayer;
        edges: VectorLayer;
    } {
        this.#guard();
        const positions = new Map(input.nodes.map(n => [n.id, n.position]));
        const edges: VectorFeature[] = input.edges.map(e => { const a = positions.get(e.source), b = positions.get(e.target); if (!a || !b)
            throw vectorInvalid("graph edge references unknown node"); return { id: e.id, kind: "line", positions: [a, b], ...(e.style ? { style: e.style } : {}), ...(e.properties ? { properties: e.properties } : {}) }; });
        const nodes: VectorFeature[] = input.nodes.map(n => ({ id: n.id, kind: "point", position: n.position, ...(n.style ? { style: n.style } : {}), ...(n.properties ? { properties: n.properties } : {}) }));
        // Validate the whole graph before mutating either layer.
        const drape = input.drape === undefined ? {} : { drape: input.drape };
        const edgeInput = { name: `${input.name}:edges`, features: edges, style: { ...input.edgeStyle, ...drape }, zOrder: 0 };
        const nodeInput = { name: `${input.name}:nodes`, features: nodes, style: { ...input.nodeStyle, ...drape }, zOrder: 1 };
        this.#normalize({ ...edgeInput, layerId: this.#nextId });
        this.#normalize({ ...nodeInput, layerId: this.#nextId + 1 });
        const ids = [...edges, ...nodes].map(f => f.id);
        if (new Set(ids).size !== ids.length)
            throw vectorInvalid("duplicate graph feature ID");
        return { edges: this.add(edgeInput), nodes: this.add(nodeInput) };
    }
    #normalize(input: VectorLayerInput & {
        layerId: number;
    }, replace?: number): VectorLayerSnapshot {
        if (!Number.isSafeInteger(input.layerId) || input.layerId < 1)
            throw vectorInvalid("layer ID must be a positive safe integer");
        if (typeof input.name !== "string" || !input.name.trim())
            throw vectorInvalid("layer name must be nonempty");
        const features = input.features.map(validateFeature);
        const occupied = new Set([...this.#layers.values()].filter(l => l.layerId !== replace).flatMap(l => l.features.map(f => f.id)));
        for (const f of features) {
            if (occupied.has(f.id))
                throw vectorInvalid(`duplicate feature ID ${f.id}`);
            occupied.add(f.id);
        }
        const style = normalizeVectorStyle(input.style);
        const visible = input.visible ?? true, zOrder = input.zOrder ?? 0;
        if (typeof visible !== "boolean" || !Number.isSafeInteger(zOrder))
            throw vectorInvalid("invalid layer visibility or zOrder");
        if (input.atlas) {
            const a = input.atlas;
            if (!Number.isInteger(a.width) || !Number.isInteger(a.height) || !Number.isInteger(a.tileSize) || a.width < 1 || a.height < 1 || a.width > 4096 || a.height > 4096 || a.tileSize < 1 || a.width % a.tileSize || a.height % a.tileSize || !(a.rgba instanceof Uint8Array) || a.rgba.length !== a.width * a.height * 4)
                throw vectorInvalid("invalid point atlas");
        }
        for (const f of features) {
            const s = normalizeVectorStyle({ ...style, ...f.style });
            if (s.shape === "texture" && (!input.atlas || s.atlasTile >= input.atlas.width * input.atlas.height / (input.atlas.tileSize ** 2)))
                throw vectorInvalid("texture points need a valid atlas tile");
        }
        return { ...structuredClone(input), features, style, visible, zOrder };
    }
    getLayer(id: number): VectorLayerSnapshot { this.#guard(); const layer = this.#layers.get(id); if (!layer)
        throw vectorInvalid("unknown vector layer"); return structuredClone(layer); }
    updateLayer(id: number, input: Partial<VectorLayerInput>): void { const current = this.getLayer(id); const next = this.#normalize({ ...current, ...input, layerId: id }, id); this.#layers.set(id, next); this.#knownFeatureIds = undefined; this.#pruneSelection(); this.#revision++; this.#geometryRevision++; }
    removeLayer(id: number): void { this.#guard(); if (!this.#layers.delete(id))
        throw vectorInvalid("unknown vector layer"); this.#knownFeatureIds = undefined; this.#pruneSelection(); this.#revision++; this.#geometryRevision++; }
    #knownIds(): Set<number> { return this.#knownFeatureIds ??= new Set([...this.#layers.values()].flatMap(l => l.features.map(f => f.id))); }
    #pruneSelection(): void { const ids = this.#knownIds(); for (const set of this.#selections.values())
        set.ids = set.ids.filter(id => ids.has(id)); if (this.#hover !== null && !ids.has(this.#hover))
        this.#hover = null; }
    setOit(mode: VectorOitMode): void { this.#guard(); if (!["auto", "standard", "wboit", "dual-source"].includes(mode))
        throw vectorInvalid("invalid OIT mode"); this.#oit = mode; this.#revision++; this.#geometryRevision++; }
    setCulling(mode: VectorSnapshot["culling"]): void { this.#guard(); if (!["auto", "cpu", "gpu"].includes(mode))
        throw vectorInvalid("invalid culling mode"); this.#culling = mode; this.#revision++; this.#geometryRevision++; }
    setSelection(name: string, ids: readonly number[], style: VectorSelectionStyle = {}, visible = true): void { this.#guard(); if (!name.trim() || typeof visible !== "boolean")
        throw vectorInvalid("invalid selection name or visibility"); const known = this.#knownIds(); for (const id of ids) {
        validateVectorId(id);
        if (!known.has(id))
            throw vectorInvalid("selection references unknown ID");
    } this.#selections.set(name, { name, ids: [...new Set(ids)].sort((a, b) => a - b), visible, style: selectionStyle(style) }); this.#revision++; this.#highlightRevision++; }
    getSelection(name: string): VectorSelectionSet | undefined { this.#guard(); const s = this.#selections.get(name); return s ? structuredClone(s) : undefined; }
    removeSelection(name: string): boolean { this.#guard(); const removed = this.#selections.delete(name); if (removed)
        { this.#revision++; this.#highlightRevision++; } return removed; }
    setHover(id: number | null, style?: VectorSelectionStyle): void { this.#guard(); if (id !== null) {
        validateVectorId(id);
        if (!this.#knownIds().has(id))
            throw vectorInvalid("hover references unknown ID");
    } this.#hover = id; if (style)
        this.#hoverStyle = selectionStyle(style); this.#revision++; this.#highlightRevision++; }
    setTimeSeconds(time: number): void { this.#guard(); if (!Number.isFinite(time))
        throw vectorInvalid("time must be finite"); this.#time = time; this.#revision++; this.#highlightRevision++; }
    highlightSnapshot(): Pick<VectorSnapshot, "selections" | "hover" | "hoverStyle" | "timeSeconds"> { this.#guard(); return { selections: structuredClone([...this.#selections.values()]), hover: this.#hover, hoverStyle: structuredClone(this.#hoverStyle), timeSeconds: this.#time }; }
    snapshot(): VectorSnapshot { this.#guard(); return { layers: structuredClone([...this.#layers.values()].sort((a, b) => a.zOrder - b.zOrder || a.layerId - b.layerId)), oit: this.#oit, culling: this.#culling, selections: structuredClone([...this.#selections.values()]), hover: this.#hover, hoverStyle: structuredClone(this.#hoverStyle), timeSeconds: this.#time }; }
    static from(snapshot: VectorSnapshot): VectorLayers { const result = new VectorLayers(); for (const layer of snapshot.layers) {
        if (result.#layers.has(layer.layerId))
            throw vectorInvalid("duplicate vector layer ID");
        const normalized = result.#normalize(layer);
        result.#layers.set(layer.layerId, normalized);
        result.#nextId = Math.max(result.#nextId, layer.layerId + 1);
    } result.setOit(snapshot.oit); result.setCulling(snapshot.culling); for (const s of snapshot.selections)
        result.setSelection(s.name, s.ids, s.style, s.visible); result.setHover(snapshot.hover, snapshot.hoverStyle); result.setTimeSeconds(snapshot.timeSeconds); return result; }
    copy(): VectorLayers { return VectorLayers.from(this.snapshot()); }
    dispose(): void { this.#layers.clear(); this.#selections.clear(); this.#knownFeatureIds = undefined; this.#hover = null; this.#disposed = true; this.#revision++; this.#geometryRevision++; this.#highlightRevision++; }
}
