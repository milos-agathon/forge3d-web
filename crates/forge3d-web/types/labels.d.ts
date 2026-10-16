import type { CameraInput, SceneNodeInput } from "./index.js";
import type { Forge3DScene } from "./index.js";
import { LabelFeatureSource } from "./label-features.js";
import type { LabelFeature, LabelFeatureOptions } from "./label-features.js";
import type { LabelPlan } from "./label-plan.js";
import { Camera } from "./index.js";
import { FontAtlas } from "./typography.js";
import type { LabelDiagnostic, LabelLayerSnapshot, LabelOperationResult, LabelPoint, LabelStyleInput, TypographyInput, KeepoutRegionInput } from "./label-types.js";
export declare class LabelFlags {
    underline: boolean;
    smallCaps: boolean;
    leader: boolean;
    constructor(input?: Partial<LabelFlags>);
}
export declare class LabelStyle {
    readonly value: Required<LabelStyleInput>;
    flags: LabelFlags;
    fontSize: number;
    color: [number, number, number, number];
    haloColor: [number, number, number, number];
    haloWidth: number;
    priority: number;
    minDepth: number;
    maxDepth: number;
    depthFade: number;
    minZoom: number;
    maxZoom: number;
    rotation: number;
    offset: [number, number];
    horizonFadeAngle: number;
    constructor(input?: LabelStyleInput & {
        flags?: Partial<LabelFlags>;
    });
    toString(): string;
    toJSON(): Required<LabelStyleInput>;
}
export interface LabelRenderOptions {
    viewport: {
        width: number;
        height: number;
    };
    camera?: Camera | CameraInput;
    zoom?: number;
    keepouts?: readonly KeepoutRegionInput[];
    maxVertexBytes?: number;
    terrain?: {
        query(x: number, z: number): {
            height?: number;
            elevation?: number;
        } | undefined;
    };
}
export interface LabelPlacementReport {
    accepted: number[];
    rejected: {
        id: number;
        reason: string;
    }[];
    diagnostics: LabelDiagnostic[];
    glyphCount: number;
    vertexBytes: number;
    nodes: SceneNodeInput[];
}
export declare class LabelLayer {
    #private;
    constructor(atlas: FontAtlas, ownsAtlas?: boolean);
    static fromFeatures(features: Iterable<LabelFeature>, options?: LabelFeatureOptions): LabelFeatureSource;
    static fromStyleLayer(features: Iterable<LabelFeature>, style: Parameters<typeof LabelFeatureSource.fromStyleLayer>[1], options?: LabelFeatureOptions): LabelFeatureSource;
    static fromRows(rows: Parameters<typeof LabelFeatureSource.fromRows>[0], options?: LabelFeatureOptions): LabelFeatureSource;
    static create(): Promise<LabelLayer>;
    addChangeListener(listener: () => void): () => void;
    get revision(): number;
    get enabled(): boolean;
    get disposed(): boolean;
    get size(): number;
    addLabel(text: string, position: LabelPoint, style?: LabelStyleInput): LabelOperationResult;
    addPlan(plan: LabelPlan, style?: LabelStyleInput): {
        ids: Record<string, number[]>;
        diagnostics: LabelDiagnostic[];
    };
    pick(x: number, y: number): number | null;
    addLabels(labels: readonly {
        text: string;
        position: LabelPoint;
        style?: LabelStyleInput;
    }[]): {
        ids: (number | null)[];
        diagnostics: LabelDiagnostic[];
    };
    addLineLabel(text: string, path: LabelPoint[], style?: LabelStyleInput, terrainMode?: string): LabelOperationResult;
    addCurvedLabel(_text: string, _path: LabelPoint[]): LabelOperationResult;
    addCallout(text: string, position: LabelPoint, style?: LabelStyleInput): LabelOperationResult;
    updateLabel(id: number, patch: {
        text?: string;
        position?: LabelPoint;
        style?: LabelStyleInput;
    }): boolean;
    removeLabel(id: number): LabelOperationResult;
    clearLabels(): void;
    setLabelsEnabled(enabled: boolean): void;
    setTypography(input: TypographyInput): void;
    setDeclutterAlgorithm(algorithm: "greedy" | "annealing", options?: {
        seed?: number;
        maxIterations?: number;
    }): void;
    snapshot(): LabelLayerSnapshot;
    static fromJSON(atlas: FontAtlas, input: LabelLayerSnapshot | string): LabelLayer;
    render(options: LabelRenderOptions): LabelPlacementReport;
    attach(scene: Forge3DScene, options: LabelRenderOptions): LabelPlacementReport;
    detach(scene: Forge3DScene): void;
    memoryReport(): {
        labels: number;
        cpuBytes: number;
        ownedFontBytes: number;
        disposed: boolean;
    };
    dispose(): void;
}
export { LabelLayer as LabelManager };
