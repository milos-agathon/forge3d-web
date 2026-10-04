import type { AcceptedLabel, LabelDiagnostic, LabelPlanData, LabelPlanOptions, LabelRejectionReason, KeepoutRegionInput, PriorityClassInput, RejectedLabel } from "./label-types.js";
export declare const LABEL_REJECTION_REASONS: readonly LabelRejectionReason[];
export declare class KeepoutRegion implements KeepoutRegionInput {
    readonly region_id: string;
    readonly kind: string;
    readonly bounds: [number, number, number, number];
    readonly priority: number;
    constructor(input: KeepoutRegionInput);
    toJSON(): Required<KeepoutRegionInput>;
}
export declare class PriorityClass implements PriorityClassInput {
    readonly name: string;
    readonly rank: number;
    readonly tie_break_policy: string;
    constructor(input: PriorityClassInput);
    toJSON(): Required<PriorityClassInput>;
}
export declare class LabelPlan {
    #private;
    constructor(input: LabelPlanData);
    get accepted(): AcceptedLabel[];
    get rejected(): RejectedLabel[];
    get diagnostics(): LabelDiagnostic[];
    get bounds(): LabelPlanData["bounds"];
    get seed(): number;
    static compile(options: LabelPlanOptions): LabelPlan;
    toJSON(): LabelPlanData;
    serialize(): string;
    static fromJSON(input: LabelPlanData | string): LabelPlan;
    toRenderPayload(backend?: string): LabelPlanData & {
        kind: string;
        backend: string;
        supported: boolean;
    };
    toExportPayload(backend?: string): LabelPlanData & {
        kind: string;
        backend: string;
        supported: boolean;
    };
}
