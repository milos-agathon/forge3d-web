import { Forge3DError } from "./index.js";
import type { VectorFeature, VectorGraphInput, VectorLayerInput, VectorLayerSnapshot, VectorOitMode, VectorSelectionSet, VectorSelectionStyle, VectorSnapshot, VectorStyle } from "./vector-types.js";
export type * from "./vector-types.js";
export declare function vectorInvalid(message: string): Forge3DError;
export declare function validateVectorId(id: number): void;
export declare function normalizeVectorStyle(style?: VectorStyle): Required<VectorStyle>;
/** Mutable layer handle. Edits are transactional and never renumber features. */
export declare class VectorLayer {
    private readonly owner;
    readonly id: number;
    constructor(owner: VectorLayers, id: number);
    snapshot(): VectorLayerSnapshot;
    update(input: Partial<Omit<VectorLayerInput, "name">> & {
        name?: string;
    }): void;
    updateFeature(id: number, feature: VectorFeature): void;
    removeFeature(id: number): boolean;
    remove(): void;
}
export declare class VectorLayers {
    #private;
    get revision(): number;
    get disposed(): boolean;
    add(input: VectorLayerInput): VectorLayer;
    addGraph(input: VectorGraphInput): {
        nodes: VectorLayer;
        edges: VectorLayer;
    };
    getLayer(id: number): VectorLayerSnapshot;
    updateLayer(id: number, input: Partial<VectorLayerInput>): void;
    removeLayer(id: number): void;
    setOit(mode: VectorOitMode): void;
    setCulling(mode: VectorSnapshot["culling"]): void;
    setSelection(name: string, ids: readonly number[], style?: VectorSelectionStyle, visible?: boolean): void;
    getSelection(name: string): VectorSelectionSet | undefined;
    removeSelection(name: string): boolean;
    setHover(id: number | null, style?: VectorSelectionStyle): void;
    setTimeSeconds(time: number): void;
    snapshot(): VectorSnapshot;
    static from(snapshot: VectorSnapshot): VectorLayers;
    copy(): VectorLayers;
    dispose(): void;
}
